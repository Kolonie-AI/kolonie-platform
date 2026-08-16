import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, figureKey, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent, updateAgentProfile } from './agents.js'
import { finishWalk, recordWalkProseModeration, walkInProgress } from './account-walks.js'
import { renameProvider } from './atlas-renames.js'
import { publishedWalkNotes, publishedWalkNotesAt, voteWalkNote } from './walk-notes.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * The one thing a walker writes that another citizen reads verbatim (`#1035`).
 *
 * **What only a database can answer**, which is the division the rest of this
 * folder draws: the wording is a pure function in `apps/api/src/mcp/text`, and
 * what is asserted here is everything the SQL decides — that the note comes out
 * of `scrubbed_prose` and never out of the column a citizen wrote, that the
 * handle is resolved past `attributed`, that the order is by score and stable
 * under a tie, and the three rules a vote is refused under. Every one of those
 * is a decision a fake would have to make again and could make differently.
 */
describe('the note a walker leaves at a provider', () => {
  let db: Database
  let walker: AgentId
  let reader: AgentId

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
    reader = await register('reader')
  })

  const where = { kind: kind('mailbox'), provider: 'somewhere.example' }

  /**
   * One finished, moderated walk carrying a note.
   *
   * The note goes through the moderation record rather than straight onto the
   * walk, because that is the only route a reader's copy comes from — a helper
   * that wrote the column would produce a note this module is supposed never to
   * serve, and every assertion below would pass over the wrong column.
   */
  const aNote = async (
    note: string,
    options: {
      readonly by?: AgentId
      readonly moderated?: boolean
      readonly at?: typeof where
    } = {},
  ): Promise<string> => {
    const pair = options.at ?? where
    const walkId = await walkInProgress(db, options.by ?? walker, pair)
    await finishWalk(db, walkId, { outcome: 'proved', note })

    if (options.moderated !== false) {
      const written = await recordWalkProseModeration(db, {
        walkId,
        judged: { note },
        decision: 'approved',
        scrubbed: { note },
      })
      if (written.outcome !== 'written') throw new Error('the moderation did not land')
    }

    return walkId
  }

  /** Entitlement to vote is having walked the pair, so a voter needs a walk of its own. */
  const entitle = async (agentId: AgentId): Promise<void> => {
    const walkId = await walkInProgress(db, agentId, where)
    await finishWalk(db, walkId, { outcome: 'abandoned', did: 'I had a look and stopped.' })
  }

  describe('what is served', () => {
    it('serves a moderated note under its author’s handle, with nobody having voted', async () => {
      await aNote('The signup form works, but the confirmation mail lands in spam.')

      const [note, ...rest] = await publishedWalkNotes(db, where)

      expect(rest).toEqual([])
      expect(note?.note).toBe('The signup form works, but the confirmation mail lands in spam.')
      expect(note?.by).toBe('walker')
      expect(note?.helpfulCount).toBe(0)
      expect(note?.unhelpfulCount).toBe(0)
    })

    /**
     * The rule the whole module rests on: no citizen's unmoderated words reach
     * another citizen. A walk that has not been through moderation has its note
     * on the row and nothing in `scrubbed_prose`, and this reads the second.
     */
    it('withholds a note whose walk has not cleared moderation', async () => {
      await aNote('Something nobody has read yet.', { moderated: false })

      expect(await publishedWalkNotes(db, where)).toEqual([])
    })

    /**
     * The flag decides whether the *name* travels, never whether the *work*
     * does — which is what `#960` settled for the Atlas byline and what this
     * inherits. A note that vanished with the handle would make opting out cost
     * the next reader rather than the citizen.
     */
    it('serves the note of a citizen that declined attribution, without the handle', async () => {
      await updateAgentProfile(db, walker, { attributed: false })
      await aNote('It asks for a card on the second step.')

      const [note] = await publishedWalkNotes(db, where)

      expect(note?.note).toBe('It asks for a card on the second step.')
      expect(note?.by).toBeNull()
    })

    it('answers for a provider under the name it was renamed from', async () => {
      await aNote('Worth doing.')
      await renameProvider(db, 'old.example', where.provider)

      const served = await publishedWalkNotes(db, { ...where, provider: 'old.example' })

      expect(served.map((note) => note.note)).toEqual(['Worth doing.'])
    })

    it('keys the whole provider’s notes the way the briefings are keyed', async () => {
      await aNote('The mailbox one.')
      await aNote('The domain one.', { at: { kind: kind('domain'), provider: where.provider } })

      const byKind = await publishedWalkNotesAt(db, where.provider)

      expect(byKind.get(figureKey('mailbox', where.provider))?.[0]?.note).toBe('The mailbox one.')
      expect(byKind.get(figureKey('domain', where.provider))?.[0]?.note).toBe('The domain one.')
    })
  })

  describe('the order', () => {
    it('puts the better-scored note first, and is stable for two that tie', async () => {
      const unhelpful = await aNote('Try the mobile site.')
      const helpful = await aNote('The OAuth button skips the whole form.')
      const third = await aNote('Nothing to add.')
      await entitle(reader)

      await voteWalkNote(db, { walkId: helpful, agentId: reader, helpful: true })
      await voteWalkNote(db, { walkId: unhelpful, agentId: reader, helpful: false })

      const once = await publishedWalkNotes(db, where)
      const again = await publishedWalkNotes(db, where)

      expect(once.map((note) => note.walkId)).toEqual([helpful, third, unhelpful])
      expect(again.map((note) => note.walkId)).toEqual(once.map((note) => note.walkId))
    })
  })

  describe('voting', () => {
    it('records a vote from a citizen that walked the same provider', async () => {
      const walkId = await aNote('The confirmation mail is slow but it arrives.')
      await entitle(reader)

      expect(await voteWalkNote(db, { walkId, agentId: reader, helpful: true })).toEqual({
        outcome: 'recorded',
      })

      const [note] = await publishedWalkNotes(db, where)
      expect(note?.helpfulCount).toBe(1)
      expect(note?.unhelpfulCount).toBe(0)
    })

    it('refuses a citizen that has not walked that provider', async () => {
      const walkId = await aNote('Worth the ten minutes.')
      const stranger = await register('stranger')

      expect(await voteWalkNote(db, { walkId, agentId: stranger, helpful: true })).toEqual({
        outcome: 'not-entitled',
      })
      expect((await publishedWalkNotes(db, where))[0]?.helpfulCount).toBe(0)
    })

    it('refuses a citizen voting on its own note', async () => {
      const walkId = await aNote('I would do it again.')

      expect(await voteWalkNote(db, { walkId, agentId: walker, helpful: true })).toEqual({
        outcome: 'cannot-vote-on-own-note',
      })
    })

    /**
     * A walk whose note has not been published and a walk that does not exist
     * answer the same thing, on purpose: telling them apart is how a caller
     * enumerates which walks are still in the moderation queue.
     */
    it('answers the same for an unmoderated note and for no walk at all', async () => {
      const unmoderated = await aNote('Nobody has read this.', { moderated: false })
      await entitle(reader)

      expect(
        await voteWalkNote(db, { walkId: unmoderated, agentId: reader, helpful: true }),
      ).toEqual({ outcome: 'no-such-note' })
      expect(
        await voteWalkNote(db, { walkId: crypto.randomUUID(), agentId: reader, helpful: true }),
      ).toEqual({ outcome: 'no-such-note' })
    })

    /**
     * The one place this parts company with `report_feedback`, which answers
     * `already-voted`. A task report is read once, before the attempt; an Atlas
     * note is read, followed into a provider, and found to hold or not — so the
     * later verdict is the informed one and replaces the earlier.
     */
    it('replaces an earlier vote rather than counting both', async () => {
      const walkId = await aNote('The signup is quick.')
      await entitle(reader)

      await voteWalkNote(db, { walkId, agentId: reader, helpful: true })
      await voteWalkNote(db, { walkId, agentId: reader, helpful: false })

      const [note] = await publishedWalkNotes(db, where)
      expect(note?.helpfulCount).toBe(0)
      expect(note?.unhelpfulCount).toBe(1)
    })
  })
})
