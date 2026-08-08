import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  DEFAULT_SIGNUP_PACE_PER_DAY,
  RegisterAgentRequestSchema,
  SIGNUP_PACE_VAR,
  type AgentId,
  type HumanId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, personOf, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { mintAccountProof } from './account-proofs.js'
import { writeProviderRecipe } from './provider-recipes.js'
import { paceCeiling, signupPace } from './signup-pace.js'
import { settingsReader, writeSetting } from './settings.js'
import { issueCodeForHuman, redeemCodeAsAgent } from './human-links.js'
import { findOrCreateHuman } from './humans.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * How fast one operator may fill the register at one provider (`#532`).
 *
 * **The unit under test is the operator and not the agent**, so every test here has two
 * agents in it. A cap that counted per agent would pass a single-agent test and let a
 * swarm of a hundred produce a hundred accounts in an hour — which is the pattern that
 * gets all of them flagged, including the ones already working.
 */
describe('the signup pace', () => {
  let db: Database
  let one: AgentId
  let two: AgentId
  let alone: AgentId
  let settings: ReturnType<typeof settingsReader>
  let operator: HumanId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    // A reader with no cache window, so a test does not wait thirty seconds for a
    // setting it just wrote.
    settings = settingsReader(db, { maxStalenessMs: 0 })
    one = await register('first')
    two = await register('second')
    alone = await register('unoperated')

    /**
     * One operator, two agents — the shape the cap is about. Linked the way a real
     * pairing happens, through a code, rather than by writing the join row: the query
     * `signupPace` makes is two hops through `human_agents` and a fixture that inserted
     * directly could pass while the real linkage was shaped differently.
     */
    const human = personOf(
      await findOrCreateHuman(db, {
        provider: 'github',
        subject: `paced-${Date.now()}`,
        email: 'operator@example.org',
      }),
    )
    operator = human.id
    for (const agent of [one, two]) {
      const { code } = await issueCodeForHuman(db, human.id)
      const linked = await redeemCodeAsAgent(db, code, agent)
      if (linked.outcome !== 'linked') throw new Error(linked.outcome)
    }
  })

  /**
   * Write the cap, the way a maintainer does.
   *
   * Through `writeSetting` rather than by inserting the row, so the test exercises the
   * refusal path too: a value the setting's own schema rejects must not silently become
   * the ceiling. `by` is required, which is the point of the table — a change to a limit
   * records who made it.
   */
  const pace = async (value: string): Promise<void> => {
    const written = await writeSetting(db, { name: SIGNUP_PACE_VAR, value, by: operator })
    if (written.outcome !== 'written') throw new Error(JSON.stringify(written))
  }

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)

    return result.agent.id
  }

  const open = (agent: AgentId, provider = 'trello.com') =>
    mintAccountProof(
      db,
      agent,
      {
        kind: kind('trello'),
        identifier: `${agent}-${Math.random()}`,
        method: 'provider-post',
        provider: provider as never,
      },
      settings,
    )

  it('counts the swarm and not the agent', async () => {
    await pace('2')

    expect((await open(one)).outcome).toBe('minted')
    // The second agent's first signup is the operator's *second*, which is the whole
    // point: a provider sees one responsible party.
    expect((await open(two)).outcome).toBe('minted')

    const third = await open(one)
    expect(third.outcome).toBe('defer')
  })

  it('defers rather than failing, and says when a slot frees', async () => {
    await pace('1')
    await open(one)

    const deferred = await open(two)

    expect(deferred.outcome).toBe('defer')
    if (deferred.outcome !== 'defer') return
    expect(deferred.used).toBe(1)
    expect(deferred.ceiling).toBe(1)
    // A real figure rather than *tomorrow*: an agent can plan around a number.
    expect(deferred.retryAfterMs).toBeGreaterThan(0)
    expect(deferred.retryAfterMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })

  it('costs nothing when it defers', async () => {
    await pace('1')
    await open(one)
    await open(two)

    // Nothing minted means nothing to clean up and no string the citizen now holds
    // and cannot use — which is what makes this a wait rather than a failure.
    const within = await signupPace(db, settings, two, kind('trello'), 'trello.com')
    expect(within.outcome).toBe('defer')
    expect(within.used).toBe(1)
  })

  it('is per provider, so one provider’s cap does not stop another', async () => {
    await pace('1')
    await open(one, 'trello.com')

    expect((await open(two, 'trello.com')).outcome).toBe('defer')
    // A different provider counts separately: the abuse pattern is per provider's
    // abuse team, and one refusing volume says nothing about another.
    expect((await open(two, 'linear.app')).outcome).toBe('minted')
  })

  it('does not cap a citizen with no operator', async () => {
    await pace('1')

    expect((await open(alone)).outcome).toBe('minted')
    /**
     * **One responsible party with one agent, so there is nothing to aggregate.**
     * Capping it would be capping the case the limit was never about — and the
     * self-operated citizen is the one least able to ask somebody to wait for it.
     */
    expect((await open(alone)).outcome).toBe('minted')
  })

  it('does not cap a proof that names no provider', async () => {
    await pace('1')

    const first = await mintAccountProof(
      db,
      one,
      {
        kind: kind('trello'),
        identifier: 'no-provider-1',
        method: 'provider-post',
      },
      settings,
    )
    const second = await mintAccountProof(
      db,
      two,
      {
        kind: kind('trello'),
        identifier: 'no-provider-2',
        method: 'provider-post',
      },
      settings,
    )

    // The provider field gates nothing by construction, and a cap that throttled a
    // citizen for declining to say where its account is would make it a gate.
    expect(first.outcome).toBe('minted')
    expect(second.outcome).toBe('minted')
  })

  it('mints exactly as before when no reader is wired', async () => {
    await pace('1')

    // Absent means no cap rather than a cap of zero: failing closed on a
    // misconfiguration would stop every signup, which is worse than a burst.
    expect(
      (
        await mintAccountProof(db, one, {
          kind: kind('trello'),
          identifier: 'uncapped-1',
          method: 'provider-post',
          provider: 'trello.com' as never,
        })
      ).outcome,
    ).toBe('minted')
    expect(
      (
        await mintAccountProof(db, two, {
          kind: kind('trello'),
          identifier: 'uncapped-2',
          method: 'provider-post',
          provider: 'trello.com' as never,
        })
      ).outcome,
    ).toBe('minted')
  })

  describe('the ceiling', () => {
    it('is the conservative default when nothing says otherwise', async () => {
      expect(await paceCeiling(db, settings, kind('trello'), 'trello.com')).toBe(
        DEFAULT_SIGNUP_PACE_PER_DAY,
      )
    })

    it('is the setting when one is written, with no deploy', async () => {
      await pace('9')

      expect(await paceCeiling(db, settings, kind('trello'), 'trello.com')).toBe(9)
    })

    it('lets a catalogue entry lower it', async () => {
      await pace('9')
      await writeProviderRecipe(db, {
        kind: kind('trello'),
        provider: 'trello.com',
        title: 'Trello',
        status: 'joinable',
        steps: [{ actor: 'agent', instruction: 'Sign up.' }],
        proves: 'provider-post',
        pacePerDay: 2,
      })

      expect(await paceCeiling(db, settings, kind('trello'), 'trello.com')).toBe(2)
    })

    it('never lets a catalogue entry raise it', async () => {
      await pace('2')
      await writeProviderRecipe(db, {
        kind: kind('trello'),
        provider: 'trello.com',
        title: 'Trello',
        status: 'joinable',
        steps: [{ actor: 'agent', instruction: 'Sign up.' }],
        proves: 'provider-post',
        pacePerDay: 50,
      })

      /**
       * **Content may lower a safety ceiling and never raise one.** A catalogue entry
       * is edited more often and by more hands than a setting is, so letting one raise
       * the limit would mean the conservative default could be undone by an edit
       * nobody reviewed as a limit change.
       */
      expect(await paceCeiling(db, settings, kind('trello'), 'trello.com')).toBe(2)
    })
  })
})
