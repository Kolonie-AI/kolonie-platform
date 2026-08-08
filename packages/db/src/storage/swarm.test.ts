import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { findOrCreateHuman } from './humans.js'
import { issueCodeForHuman, redeemCodeAsAgent } from './human-links.js'
import { shareASwarm, swarmMembers, swarmOf, swarmPortrait, swarmPortraitOf } from './swarm.js'

const target = databaseTestTarget()

/**
 * A swarm is the set of agents linked to one human account (`#510`).
 *
 * The two properties worth stating before the tests: membership is **derived**
 * from `human_agents` and stored nowhere a second time, and an agent nobody
 * operates is **a swarm of one** rather than a member of a residual group.
 */
describe('the swarm an agent is in', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aPerson = async (subject: string) => {
    const { human } = await findOrCreateHuman(db, {
      provider: 'github',
      subject,
      email: `${subject}@example.com`,
    })
    return human
  }

  /** The real path: a person issues a code and the agent redeems it (`#426`). */
  const link = async (humanId: HumanId, agentId: AgentId): Promise<void> => {
    const { code } = await issueCodeForHuman(db, humanId)
    const result = await redeemCodeAsAgent(db, code, agentId)
    if (result.outcome !== 'linked') throw new Error(result.outcome)
  }

  const sorted = (ids: readonly AgentId[]): AgentId[] => [...ids].sort()

  describe('membership', () => {
    it('answers which agents one person operates', async () => {
      const person = await aPerson('4815162342')
      const first = await anAgent('first')
      const second = await anAgent('second')
      await link(person.id, first)
      await link(person.id, second)

      expect(sorted(await swarmMembers(db, person.id))).toEqual(sorted([first, second]))
    })

    it('gives a person who operates nothing an empty answer rather than an error', async () => {
      const person = await aPerson('nobody')

      expect(await swarmMembers(db, person.id)).toEqual([])
    })

    it('names the operator and every sibling when asked from one agent', async () => {
      const person = await aPerson('4815162342')
      const one = await anAgent('one')
      const other = await anAgent('other')
      await link(person.id, one)
      await link(person.id, other)

      const swarm = await swarmOf(db, one)

      expect(swarm.operator).toBe(person.id)
      expect(sorted(swarm.members)).toEqual(sorted([one, other]))
    })

    /**
     * The cautious direction, and `#513` is what it protects: treating an
     * unlinked agent as sharing a swarm with the other unlinked ones would file
     * strangers' work as internal, which is the flattery being removed.
     */
    it('treats an agent nobody operates as its own swarm', async () => {
      const alone = await anAgent('alone')

      expect(await swarmOf(db, alone)).toEqual({ operator: undefined, members: [alone] })
    })
  })

  describe('whether two citizens answer to the same person', () => {
    it('is true for two agents linked to one person', async () => {
      const person = await aPerson('4815162342')
      const one = await anAgent('one')
      const other = await anAgent('other')
      await link(person.id, one)
      await link(person.id, other)

      expect(await shareASwarm(db, one, other)).toBe(true)
      expect(await shareASwarm(db, other, one)).toBe(true)
    })

    it('is false across two people', async () => {
      const mine = await aPerson('mine')
      const theirs = await aPerson('theirs')
      const one = await anAgent('one')
      const other = await anAgent('other')
      await link(mine.id, one)
      await link(theirs.id, other)

      expect(await shareASwarm(db, one, other)).toBe(false)
    })

    /** Unknown is not a shared operator, on the same reasoning as the swarm of one. */
    it('is false between two agents that nobody operates', async () => {
      const one = await anAgent('one')
      const other = await anAgent('other')

      expect(await shareASwarm(db, one, other)).toBe(false)
    })

    it('is false when only one of the two has an operator', async () => {
      const person = await aPerson('4815162342')
      const linked = await anAgent('linked')
      const alone = await anAgent('alone')
      await link(person.id, linked)

      expect(await shareASwarm(db, linked, alone)).toBe(false)
      expect(await shareASwarm(db, alone, linked)).toBe(false)
    })

    it('holds for an agent and itself, because D-052 is what forbids that case', async () => {
      const alone = await anAgent('alone')

      expect(await shareASwarm(db, alone, alone)).toBe(true)
    })
  })

  /**
   * Membership has no table, and this is the assertion that says so at the level
   * where it could stop being true. A `swarms` table would be a second record of
   * what `human_agents` already holds — the duplication D-002 refused for the
   * ledger.
   */
  it('stores membership nowhere, so there is nothing to keep in step', async () => {
    const tables = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    )
    const names = tables.map((row) => row.table_name)

    // The read is the whole basis of the check, so an empty one would pass by
    // finding nothing rather than by there being nothing to find.
    expect(names).toContain('human_agents')
    expect(names.filter((name) => name.includes('swarm'))).toEqual([])
  })
  /**
   * The portrait (`kolonie-website#63`).
   *
   * **These tests exist because their absence reached production.** The two
   * queries in `swarmPortrait` are raw `sql` templates, which typecheck whatever
   * is inside them — so `decided_at`, a local variable in `recordVerdict` and
   * not a column, passed every check in this repository and answered `500` on
   * the first real request. A raw query that no test executes is a query nobody
   * has run.
   */
  describe('the portrait', () => {
    it('draws every member with its runtime, model and what it proved', async () => {
      const person = await aPerson('portrait-1')
      const first = await anAgent('first')
      const second = await anAgent('second')
      await link(person.id, first)
      await link(person.id, second)

      const portrait = await swarmPortrait(db, first)

      expect(portrait?.members.map((member) => member.name)).toEqual(['first', 'second'])
      expect(portrait?.members[0]).toMatchObject({ runtime: 'openclaw', model: null, proved: [] })
    })

    /**
     * The claim is the families rather than the count, so an agent that has
     * declared nothing is not one — and two agents on one model are one family.
     */
    it('counts model families and not agents', async () => {
      const person = await aPerson('portrait-2')
      const first = await anAgent('first')
      const second = await anAgent('second')
      const third = await anAgent('third')
      await link(person.id, first)
      await link(person.id, second)
      await link(person.id, third)

      await db.execute(sql`update agents set model = 'one/model' where name in ('first', 'second')`)

      const portrait = await swarmPortrait(db, first)

      expect(portrait?.members).toHaveLength(3)
      expect(portrait?.modelFamilies).toBe(1)
    })

    /**
     * The second query, which is the one that was wrong. `null` until a report
     * has been accepted inside the swarm, and the page draws that as *not yet*.
     */
    it('answers null for work that has not moved inside the swarm yet', async () => {
      const person = await aPerson('portrait-3')
      const only = await anAgent('only')
      await link(person.id, only)

      expect((await swarmPortrait(db, only))?.workThatMoved).toBeNull()
    })

    /**
     * **The operator's own console identity is not a member of the swarm it
     * belongs to** (`#455`, `kolonie-website#63`).
     *
     * It is an ordinary linked agent in every technical respect and it is the
     * person in every other — `#455` labels it `You` on the console for exactly
     * that reason. A page claiming *these are agents that specialise and earn*
     * would otherwise list a human among them, and `#63` refuses anything that
     * identifies the human outright.
     *
     * Not `#423`'s rule about drawing zeros: that one is about the operator's
     * own fleet page, where hiding an idle agent hides what needs attention.
     */
    it('leaves out the operator’s own console identity', async () => {
      const person = await aPerson('portrait-5')
      const worker = await anAgent('worker')
      const console_ = await anAgent('sponsor-abc123')
      await link(person.id, worker)
      await link(person.id, console_)

      await db.execute(
        sql`update agents set registration_path = 'web' where name = 'sponsor-abc123'`,
      )

      const portrait = await swarmPortrait(db, worker)

      expect(portrait?.members.map((member) => member.name)).toEqual(['worker'])
    })

    it('has no portrait for an agent nobody operates', async () => {
      expect(await swarmPortrait(db, await anAgent('unoperated'))).toBeUndefined()
    })

    describe('by handle, which is what the setting holds', () => {
      it('finds it case-insensitively', async () => {
        const person = await aPerson('portrait-4')
        const only = await anAgent('Only')
        await link(person.id, only)

        expect((await swarmPortraitOf(db, 'only'))?.members).toHaveLength(1)
      })

      it('answers nothing for a handle no agent holds', async () => {
        expect(await swarmPortraitOf(db, 'nobody-by-that-name')).toBeUndefined()
      })
    })
  })
})

/**
 * `agents.operator` describes and never decides (`#510`).
 *
 * It is free text a citizen writes about itself — nine spellings for about three
 * real operators, measured across twenty-seven agents on 2026-08-07 — and it
 * stays, because what a citizen says about itself is worth reading. What must
 * not happen is a code path treating it as identity, which would make the
 * spellings load-bearing.
 *
 * The scan strips comments first, so that a file may go on *explaining* the
 * column — this one does — while being held to not reading it.
 */
describe('agents.operator', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

  /**
   * Where identity is decided: what may be attempted, what is accepted, what is
   * paid, what is counted, and what the maintainer is shown. `swarm.ts` is in the
   * list because the temptation is strongest in the file that answers the
   * question the column looks like an answer to.
   */
  const DECIDING = [
    'packages/db/src/storage/tasks.ts',
    'packages/db/src/storage/attempts.ts',
    'packages/db/src/storage/submissions.ts',
    'packages/db/src/storage/rewards.ts',
    'packages/db/src/storage/balance.ts',
    'packages/db/src/storage/escrow.ts',
    'packages/db/src/storage/quests/read.ts',
    'packages/db/src/storage/quests/write.ts',
    'packages/db/src/storage/quests/steward.ts',
    'packages/db/src/storage/quests/shared.ts',
    'packages/db/src/storage/skills.ts',
    'packages/db/src/storage/distinct-operators.ts',
    'packages/db/src/storage/colony-numbers.ts',
    'packages/db/src/storage/standing-hints.ts',
    'packages/db/src/storage/swarm.ts',
    'apps/api/src/routes/privileged.ts',
  ] as const

  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('is read by nothing that decides, and human_agents is what identity comes from', () => {
    // `operatorAddresses`, `operatesAgent` and `operatorOf` are deliberately not
    // matched: they are the proved relationship, which is the thing that may be
    // branched on.
    const reads = /\b(?:agents|agent|row|citizen|profile|mine|theirs)\.operator\b/

    for (const file of DECIDING) {
      const source = withoutComments(readFileSync(`${repoRoot}${file}`, 'utf8'))

      expect(reads.test(source), `${file} must not treat agents.operator as identity`).toBe(false)
      expect(source.includes(`'operator'`), `${file} must not select the operator column`).toBe(
        false,
      )
    }
  })
})
