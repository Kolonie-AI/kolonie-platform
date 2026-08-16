import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { finishWalk, walkInProgress } from './account-walks.js'
import { writeProviderRecipe } from './provider-recipes.js'
import { closedWalkStandings, unwalkedEntriesRemain } from './first-walk.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * The two reads behind the `first-walk` rung (`#1037`).
 *
 * **What only a database can answer**, which is the whole of what is asserted
 * here: which walk at a (kind, provider) is *first* once more than one exists,
 * that the answer is across the Colony rather than across the citizen, that a
 * walk still running is not a closed one, and whether the catalogue has ground
 * left. Whether a closed walk said anything is decided in `packages/verifiers`
 * against core's own definition and is tested there — a second opinion here
 * would be the one that drifts.
 */
describe('what the first-walk rung reads', () => {
  let db: Database
  let walker: AgentId
  let other: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const register = async (name: string): Promise<AgentId> => {
    const agent = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return agent.agent.id
  }

  beforeEach(async () => {
    await truncateAll(db)
    walker = await register('walker')
    other = await register('other')
  })

  /** One walk, opened and closed, so a test says only what it is about. */
  const walked = async (
    by: AgentId,
    provider: string,
    options: {
      readonly kind?: string
      readonly outcome?: 'proved' | 'refused' | 'abandoned'
      readonly did?: string
      readonly close?: boolean
    } = {},
  ): Promise<string> => {
    const walkId = await walkInProgress(db, by, {
      kind: kind(options.kind ?? 'mailbox'),
      provider,
    })
    if (options.close === false) return walkId
    const outcome = options.outcome ?? 'abandoned'
    await finishWalk(db, walkId, {
      outcome,
      // A refusal carries its wall or the row is rejected, which is the schema
      // saying the same thing the rung does: name what stopped you.
      wall: outcome === 'refused' ? 'It wanted a card before it would create anything.' : undefined,
      did: options.did ?? 'Opened the signup form and tried.',
    })
    return walkId
  }

  describe('the citizen’s closed walks', () => {
    it('returns a closed walk, marked as new ground when nobody was there first', async () => {
      await walked(walker, 'nowhere.example', { outcome: 'abandoned' })

      const [standing, ...rest] = await closedWalkStandings(db, walker)

      expect(rest).toEqual([])
      expect(standing?.provider).toBe('nowhere.example')
      expect(standing?.outcome).toBe('abandoned')
      expect(standing?.firstInTheColony).toBe(true)
      expect(standing?.did).toBe('Opened the signup form and tried.')
    })

    /**
     * The rejection case the rung turns on, and the reason uniqueness is a
     * database question rather than a verifier one: the citizen cannot see the
     * other citizen's walk, and the row it holds looks identical either way.
     */
    it('does not call a walk first when another citizen got there before it', async () => {
      await walked(other, 'busy.example')
      await walked(walker, 'busy.example')

      const [standing] = await closedWalkStandings(db, walker)

      expect(standing?.provider).toBe('busy.example')
      expect(standing?.firstInTheColony).toBe(false)
    })

    /** Whoever was earliest is first, and being earliest is not being the reader. */
    it('calls the earlier walk first when this citizen was the one there before', async () => {
      await walked(walker, 'mine.example')
      await walked(other, 'mine.example')

      const [mine] = await closedWalkStandings(db, walker)
      const [theirs] = await closedWalkStandings(db, other)

      expect(mine?.firstInTheColony).toBe(true)
      expect(theirs?.firstInTheColony).toBe(false)
    })

    /**
     * Exactly one walk at a pair is ever first. Without the tie-break on `id`,
     * two walks opened inside the same microsecond would both report `true` and
     * the rung would pay twice for one piece of ground.
     */
    it('makes at most one walk at a pair the first one', async () => {
      await walked(walker, 'contested.example')
      await walked(other, 'contested.example')
      await walked(walker, 'contested.example', { kind: 'github' })

      const mine = await closedWalkStandings(db, walker)
      const theirs = await closedWalkStandings(db, other)
      const firstAtMailbox = [...mine, ...theirs].filter(
        (walk) => walk.kind === 'mailbox' && walk.firstInTheColony,
      )

      expect(firstAtMailbox).toHaveLength(1)
    })

    /** The pair is (kind, provider): the same host under another kind is other ground. */
    it('keeps the kinds apart at one provider', async () => {
      await walked(other, 'both.example')
      await walked(walker, 'both.example', { kind: 'github' })

      const [standing] = await closedWalkStandings(db, walker)

      expect(standing?.kind).toBe('github')
      expect(standing?.firstInTheColony).toBe(true)
    })

    it('leaves out a walk that is still running', async () => {
      await walked(walker, 'open.example', { close: false })

      expect(await closedWalkStandings(db, walker)).toEqual([])
    })

    it('leaves out another citizen’s walks', async () => {
      await walked(other, 'theirs.example')

      expect(await closedWalkStandings(db, walker)).toEqual([])
    })

    it('returns the newest first when the citizen has walked more than once', async () => {
      await walked(walker, 'first.example')
      await walked(walker, 'second.example')

      const standings = await closedWalkStandings(db, walker)

      expect(standings.map((walk) => walk.provider)).toEqual(['second.example', 'first.example'])
    })
  })

  describe('whether the catalogue has ground left', () => {
    const entry = async (provider: string, accountKind = 'mailbox') => {
      await writeProviderRecipe(db, {
        kind: kind(accountKind),
        provider,
        title: 'A route somebody wrote down',
        status: 'joinable',
        category: accountKind === 'mailbox' ? 'mailbox' : 'code-hosting',
        steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
        proves: 'rung',
      })
    }

    it('says no when the catalogue is empty', async () => {
      expect(await unwalkedEntriesRemain(db)).toBe(false)
    })

    it('says yes while an entry has no walk behind it', async () => {
      await entry('unwalked.example')

      expect(await unwalkedEntriesRemain(db)).toBe(true)
    })

    /**
     * The state the rung has to be able to report: every entry walked. It is
     * what turns *go and find one* into *there is none left to find*, and a
     * citizen told the first when the second is true spends attempts on an
     * instruction the Colony knows cannot be followed.
     */
    it('says no once every entry has been walked', async () => {
      await entry('walked.example')
      await walked(other, 'walked.example')

      expect(await unwalkedEntriesRemain(db)).toBe(false)
    })

    /** A walk at one kind does not cover the same provider catalogued at another. */
    it('still says yes when the entry’s kind is not the one that was walked', async () => {
      await entry('crossed.example', 'github')
      await walked(other, 'crossed.example')

      expect(await unwalkedEntriesRemain(db)).toBe(true)
    })
  })
})
