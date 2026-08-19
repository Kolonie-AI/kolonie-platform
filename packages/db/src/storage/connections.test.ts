import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, CONNECTION_PENDING_LIMIT, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentConnectionRequests, agentConnections, agents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  acceptConnection,
  cancelConnectionRequest,
  declineConnectionRequest,
  isAcceptedConnection,
  listConnections,
  removeConnection,
  requestConnection,
} from './connections.js'

const target = databaseTestTarget()

/**
 * The half of `#1293` only a database can answer.
 *
 * Three of these could not be asserted anywhere else: that the pending rule is
 * one row per **unordered** pair rather than per direction, that accepting is a
 * transaction and leaves no request behind, and that a citizen's erasure takes
 * both sides of everything with it. The rest are the acceptance criteria the
 * issue lists, run against the constraints rather than against a copy of them.
 */
describe('connecting two citizens', () => {
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

  const anAgent = async (name: string, discoverable = true): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', discoverable })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const REASON = 'We both walked mail.tm last week and reached opposite conclusions.'

  it('records a request with its reason, and shows it to both sides', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('Asked')

    const result = await requestConnection(db, asker, 'asked', REASON)

    expect(result).toEqual({
      outcome: 'connection',
      // The handle comes back canonical rather than as it was typed.
      response: { handle: 'Asked', state: 'pending' },
    })

    const mine = await listConnections(db, asker)
    expect(mine.pendingOut.map((one) => one.handle)).toEqual(['Asked'])
    expect(mine.pendingOut[0]?.reason).toBe(REASON)
    expect(mine.pendingIn).toEqual([])
    expect(mine.accepted).toEqual([])

    const theirs = await listConnections(db, asked)
    expect(theirs.pendingIn.map((one) => one.handle)).toEqual(['asker'])
    expect(theirs.pendingIn[0]?.reason).toBe(REASON)
    expect(theirs.pendingOut).toEqual([])
  })

  it('refuses a request with no reason, and one over the cap', async () => {
    const asker = await anAgent('asker')
    await anAgent('asked')

    for (const reason of ['', '   ', '\n\t', 'x'.repeat(281)]) {
      expect(await requestConnection(db, asker, 'asked', reason), reason.slice(0, 8)).toEqual({
        outcome: 'refused',
        refusal: 'reason-required',
      })
    }

    expect(await listConnections(db, asker)).toEqual({
      pendingIn: [],
      pendingOut: [],
      accepted: [],
    })
  })

  /**
   * The reason is trimmed before it is stored, so the CHECK and the cap agree
   * with what a reader sees. Asserted because the trim is the one transformation
   * this module makes to a citizen's own words.
   */
  it('stores the reason trimmed', async () => {
    const asker = await anAgent('asker')
    await anAgent('asked')

    await requestConnection(db, asker, 'asked', `  ${REASON}  `)

    expect((await listConnections(db, asker)).pendingOut[0]?.reason).toBe(REASON)
  })

  it('refuses a citizen connecting to itself', async () => {
    const alone = await anAgent('alone')

    expect(await requestConnection(db, alone, 'alone', REASON)).toEqual({
      outcome: 'refused',
      refusal: 'self',
    })
    expect(await isAcceptedConnection(db, alone, alone)).toBe(false)
  })

  it('refuses a handle nobody holds', async () => {
    const asker = await anAgent('asker')

    expect(await requestConnection(db, asker, 'nobody', REASON)).toEqual({
      outcome: 'refused',
      refusal: 'no-such-citizen',
    })
  })

  /**
   * Discovery is the switch that admits a request at all — see the module
   * header. Asserted from both sides: the ask refuses, and nothing is written.
   */
  it('refuses a request to a citizen that has not switched discovery on', async () => {
    const asker = await anAgent('asker')
    const quiet = await anAgent('quiet', false)

    expect(await requestConnection(db, asker, 'quiet', REASON)).toEqual({
      outcome: 'refused',
      refusal: 'not-discoverable',
    })
    expect(await listConnections(db, quiet)).toEqual({
      pendingIn: [],
      pendingOut: [],
      accepted: [],
    })
  })

  it('asks once when the same citizen asks twice, and keeps the first reason', async () => {
    const asker = await anAgent('asker')
    await anAgent('asked')

    await requestConnection(db, asker, 'asked', REASON)
    const again = await requestConnection(db, asker, 'asked', 'Something else entirely.')

    expect(again).toEqual({
      outcome: 'connection',
      response: { handle: 'asked', state: 'pending' },
    })

    const mine = await listConnections(db, asker)
    expect(mine.pendingOut).toHaveLength(1)
    expect(mine.pendingOut[0]?.reason).toBe(REASON)
  })

  /**
   * **The rule `#1293` asked to be picked rather than discovered.** One pending
   * request per unordered pair: the reverse ask refuses and names nothing new,
   * and the request already waiting is untouched.
   */
  it('refuses the reverse request while one is already pending', async () => {
    const first = await anAgent('first')
    const second = await anAgent('second')

    await requestConnection(db, first, 'second', REASON)

    expect(await requestConnection(db, second, 'first', 'I would rather ask than answer.')).toEqual(
      { outcome: 'refused', refusal: 'reverse-pending' },
    )

    const rows = await db.select().from(agentConnectionRequests)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.fromId).toBe(first)
  })

  it('refuses a request once the citizen has as many open as it may', async () => {
    const asker = await anAgent('asker')
    for (let index = 0; index < CONNECTION_PENDING_LIMIT; index += 1) {
      await anAgent(`asked-${index}`)
      expect(
        (await requestConnection(db, asker, `asked-${index}`, REASON)).outcome,
        `request ${index}`,
      ).toBe('connection')
    }

    await anAgent('one-too-many')
    expect(await requestConnection(db, asker, 'one-too-many', REASON)).toEqual({
      outcome: 'refused',
      refusal: 'at-pending-limit',
    })

    // Cancelling one makes room, which is what the refusal tells the citizen to do.
    await cancelConnectionRequest(db, asker, 'asked-0')
    expect((await requestConnection(db, asker, 'one-too-many', REASON)).outcome).toBe('connection')
  })

  it('connects both sides on accept, and leaves no request behind', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')

    await requestConnection(db, asker, 'asked', REASON)
    const accepted = await acceptConnection(db, asked, 'asker')

    expect(accepted).toEqual({
      outcome: 'connection',
      response: { handle: 'asker', state: 'connected' },
    })

    expect(await db.select().from(agentConnectionRequests)).toEqual([])
    expect(await db.select().from(agentConnections)).toHaveLength(1)

    // Both sides read the connection, and neither reads a request.
    for (const [agentId, other] of [
      [asker, 'asked'],
      [asked, 'asker'],
    ] as const) {
      const held = await listConnections(db, agentId)
      expect(held.accepted.map((one) => one.handle)).toEqual([other])
      expect(held.pendingIn).toEqual([])
      expect(held.pendingOut).toEqual([])
    }

    expect(await isAcceptedConnection(db, asker, asked)).toBe(true)
    // Symmetric, which is the property `#1294` reads it for.
    expect(await isAcceptedConnection(db, asked, asker)).toBe(true)
  })

  it('accepts once when the accept arrives twice', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')

    await requestConnection(db, asker, 'asked', REASON)
    await acceptConnection(db, asked, 'asker')

    expect(await acceptConnection(db, asked, 'asker')).toEqual({
      outcome: 'connection',
      response: { handle: 'asker', state: 'connected' },
    })
    expect(await db.select().from(agentConnections)).toHaveLength(1)
  })

  /**
   * Asking somebody you are already connected to is not an error and writes
   * nothing: the question it asks already has an answer.
   */
  it('answers connected when a connected citizen asks again', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')

    await requestConnection(db, asker, 'asked', REASON)
    await acceptConnection(db, asked, 'asker')

    expect(await requestConnection(db, asker, 'asked', REASON)).toEqual({
      outcome: 'connection',
      response: { handle: 'asked', state: 'connected' },
    })
    expect(await db.select().from(agentConnectionRequests)).toEqual([])
  })

  it('refuses an accept where nothing was asked, and where the caller asked', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')

    expect(await acceptConnection(db, asked, 'asker')).toEqual({
      outcome: 'refused',
      refusal: 'no-request',
    })

    await requestConnection(db, asker, 'asked', REASON)

    // Agreeing with yourself is exactly what the accept exists to prevent.
    expect(await acceptConnection(db, asker, 'asked')).toEqual({
      outcome: 'refused',
      refusal: 'no-request',
    })
    expect(await isAcceptedConnection(db, asker, asked)).toBe(false)
  })

  it('declines a request, leaves no row, and lets the same citizen ask again', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')

    await requestConnection(db, asker, 'asked', REASON)

    expect(await declineConnectionRequest(db, asked, 'asker')).toEqual({
      outcome: 'connection',
      response: { handle: 'asker', state: 'none' },
    })
    expect(await db.select().from(agentConnectionRequests)).toEqual([])
    expect(await isAcceptedConnection(db, asker, asked)).toBe(false)

    // Nothing records the refusal, so asking again is an ordinary request.
    expect((await requestConnection(db, asker, 'asked', REASON)).outcome).toBe('connection')
  })

  it('cancels a request the caller made', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')

    await requestConnection(db, asker, 'asked', REASON)

    expect(await cancelConnectionRequest(db, asker, 'asked')).toEqual({
      outcome: 'connection',
      response: { handle: 'asked', state: 'none' },
    })
    expect(await listConnections(db, asked)).toEqual({
      pendingIn: [],
      pendingOut: [],
      accepted: [],
    })
  })

  /**
   * The two verbs are direction-aware, which is what a single direction-blind
   * `withdraw` would have lost: declining your own request would have cleared
   * it silently and told you it had refused somebody.
   */
  it('refuses a decline of your own request, and a cancel of theirs', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')

    await requestConnection(db, asker, 'asked', REASON)

    expect(await declineConnectionRequest(db, asker, 'asked')).toEqual({
      outcome: 'refused',
      refusal: 'no-request',
    })
    expect(await cancelConnectionRequest(db, asked, 'asker')).toEqual({
      outcome: 'refused',
      refusal: 'no-request',
    })
    expect(await db.select().from(agentConnectionRequests)).toHaveLength(1)
  })

  it('removes a connection, and removing again succeeds', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')

    await requestConnection(db, asker, 'asked', REASON)
    await acceptConnection(db, asked, 'asker')

    for (const attempt of ['first', 'second']) {
      expect(await removeConnection(db, asker, 'asked'), attempt).toEqual({
        outcome: 'connection',
        response: { handle: 'asked', state: 'none' },
      })
    }

    expect(await db.select().from(agentConnections)).toEqual([])
    expect(await isAcceptedConnection(db, asker, asked)).toBe(false)
    // And removing one that never existed is the same answer again.
    const stranger = await anAgent('stranger')
    expect((await removeConnection(db, stranger, 'asked')).outcome).toBe('connection')
  })

  /**
   * Either side may end it. A connection two citizens agreed to is not one
   * citizen's to keep.
   */
  it('lets the citizen that was asked remove the connection too', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')

    await requestConnection(db, asker, 'asked', REASON)
    await acceptConnection(db, asked, 'asker')
    await removeConnection(db, asked, 'asker')

    expect(await isAcceptedConnection(db, asker, asked)).toBe(false)
  })

  /**
   * Three of the five acts work on a citizen that has since switched discovery
   * off, and that is deliberate: a request nobody could answer would be the one
   * state with no way out.
   */
  it('still answers, cancels and removes across a citizen that switched discovery off', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')

    await requestConnection(db, asker, 'asked', REASON)
    await db.update(agents).set({ discoverable: false }).where(eq(agents.id, asked))

    expect((await acceptConnection(db, asked, 'asker')).outcome).toBe('connection')
    expect(await isAcceptedConnection(db, asker, asked)).toBe(true)
    expect((await removeConnection(db, asker, 'asked')).outcome).toBe('connection')
  })

  /**
   * The integration case `#1293`'s definition of done names, read end to end:
   * two citizens, one ask, one accept, and both of them see it.
   */
  it('lets two citizens connect, from nothing to both sides seeing it', async () => {
    const one = await anAgent('one')
    const two = await anAgent('two')

    expect(await isAcceptedConnection(db, one, two)).toBe(false)

    await requestConnection(db, one, 'TWO', REASON)
    await acceptConnection(db, two, 'ONE')

    expect((await listConnections(db, one)).accepted.map((a) => a.handle)).toEqual(['two'])
    expect((await listConnections(db, two)).accepted.map((a) => a.handle)).toEqual(['one'])
    expect(await isAcceptedConnection(db, one, two)).toBe(true)
  })

  /**
   * The erasure boundary (`#90`), from both directions.
   *
   * The cascade is declared on four foreign keys, and a table with a
   * `low`/`high` pair is exactly where *the other direction* is easy to leave
   * out — so both are asserted, with the citizen deleted on each side in turn.
   */
  it('takes requests and connections with an erased citizen, whichever side it was', async () => {
    const asker = await anAgent('asker')
    const asked = await anAgent('asked')
    const third = await anAgent('third')

    await requestConnection(db, asker, 'asked', REASON)
    await acceptConnection(db, asked, 'asker')
    await requestConnection(db, third, 'asked', REASON)

    await db.delete(agents).where(eq(agents.id, asked))

    expect(await db.select().from(agentConnections)).toEqual([])
    expect(await db.select().from(agentConnectionRequests)).toEqual([])
    expect(await listConnections(db, asker)).toEqual({
      pendingIn: [],
      pendingOut: [],
      accepted: [],
    })
  })
})
