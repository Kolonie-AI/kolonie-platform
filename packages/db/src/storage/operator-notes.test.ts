import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { MAX_UNREAD_OPERATOR_NOTES, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, autonomyContracts, operatorNotes } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { issueOperatorPage, revokeOperatorPage } from './operator-pages.js'
import {
  countUnreadOperatorNotes,
  operatorNoteRoomForToken,
  readOperatorNotes,
  writeOperatorNote,
} from './operator-notes.js'

const target = databaseTestTarget()
const OPERATOR = 'operator@example.org'
const NOTE = 'The X account is made. The handle is @foo2, not @foo.'

/**
 * The unsolicited direction (#239), against a real database.
 *
 * What is asserted here rather than in `apps/api` is everything that is a
 * property of the *queries*: that a token cannot reach another citizen's inbox,
 * that reading and marking read are one statement, that the check constraint
 * refuses a body the schema forbids, and that the cascade takes the notes with
 * the citizen. A fake can be made to agree with all four and prove none of them.
 */
describe('the operator note (#239)', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('told')
  })

  const aPage = (who: AgentId = agentId) => issueOperatorPage(db, who, OPERATOR)

  it('carries what the operator wrote, and counts it as waiting', async () => {
    const token = await aPage()

    const written = await writeOperatorNote(db, { token, body: NOTE })

    // `agentId` since `#580`: the knock has to be addressed to somebody, and
    // this is the only place the token has already been resolved to an agent.
    expect(written).toEqual({ outcome: 'written', unread: 1, agentId })
    expect(await countUnreadOperatorNotes(db, agentId)).toBe(1)
  })

  it('reads oldest first and marks them read in the same statement', async () => {
    const token = await aPage()
    await writeOperatorNote(db, { token, body: 'Use the handle @foo.' })
    await writeOperatorNote(db, { token, body: 'Correction — @foo was taken, use @foo2.' })

    const read = await readOperatorNotes(db, agentId)

    expect(read.map((note) => note.body)).toEqual([
      'Use the handle @foo.',
      'Correction — @foo was taken, use @foo2.',
    ])
    expect(await countUnreadOperatorNotes(db, agentId)).toBe(0)

    // Read, never deleted: the row survives so the record of what a person was
    // told survives with it.
    const rows = await db.select().from(operatorNotes).where(eq(operatorNotes.agentId, agentId))
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.readAt !== null)).toBe(true)
  })

  it('hands the same note to nobody twice', async () => {
    const token = await aPage()
    await writeOperatorNote(db, { token, body: NOTE })

    const [first, second] = await Promise.all([
      readOperatorNotes(db, agentId),
      readOperatorNotes(db, agentId),
    ])

    // One of the two got it and the other got nothing. Which one is a race; that
    // exactly one did is the invariant, and it is `update ... returning` that
    // holds it rather than anything in the caller.
    expect(first.length + second.length).toBe(1)
  })

  it('cannot be aimed at another citizen', async () => {
    const other = await anAgent('somebody-else')
    const token = await aPage(other)

    await writeOperatorNote(db, { token, body: NOTE })

    expect(await countUnreadOperatorNotes(db, agentId)).toBe(0)
    expect(await countUnreadOperatorNotes(db, other)).toBe(1)
    expect(await readOperatorNotes(db, agentId)).toEqual([])
  })

  it('stops the moment the page is revoked, and says nothing about why', async () => {
    const token = await aPage()
    expect((await writeOperatorNote(db, { token, body: NOTE })).outcome).toBe('written')

    await revokeOperatorPage(db, agentId, OPERATOR)

    expect(await writeOperatorNote(db, { token, body: NOTE })).toEqual({ outcome: 'unreachable' })
    // The same answer a token that never existed gets, so a stranger holding a
    // guess learns nothing from the difference.
    expect(await writeOperatorNote(db, { token: 'nothing-like-a-token', body: NOTE })).toEqual({
      outcome: 'unreachable',
    })
    expect(await operatorNoteRoomForToken(db, token)).toBeUndefined()
  })

  it('refuses once the unread pile reaches the ceiling, and clears when it is read', async () => {
    const token = await aPage()

    for (let index = 0; index < MAX_UNREAD_OPERATOR_NOTES; index += 1) {
      const written = await writeOperatorNote(db, { token, body: `Note number ${index + 1}.` })
      expect(written.outcome).toBe('written')
    }

    expect(await writeOperatorNote(db, { token, body: 'One more.' })).toEqual({
      outcome: 'inbox-full',
      unread: MAX_UNREAD_OPERATOR_NOTES,
    })
    expect(await operatorNoteRoomForToken(db, token)).toEqual({
      unread: MAX_UNREAD_OPERATOR_NOTES,
    })

    await readOperatorNotes(db, agentId)

    expect((await writeOperatorNote(db, { token, body: 'Now there is room.' })).outcome).toBe(
      'written',
    )
  })

  it('refuses a body the check constraint forbids', async () => {
    await expectRejection(
      () => db.insert(operatorNotes).values({ agentId, body: 'no' }),
      /operator_notes_body_length/,
    )
    await expectRejection(
      () => db.insert(operatorNotes).values({ agentId, body: 'x'.repeat(2001) }),
      /operator_notes_body_length/,
    )
  })

  it('leaves with the citizen', async () => {
    const token = await aPage()
    await writeOperatorNote(db, { token, body: NOTE })

    await db.delete(agents).where(eq(agents.id, agentId))

    const rows = await db.select().from(operatorNotes)
    expect(rows).toEqual([])
  })

  /**
   * The acceptance criterion this issue turns on, asserted where the writes
   * actually happen: **no path here touches the contract.** The note is written
   * with a contract in place, and the contract is byte-for-byte what it was.
   */
  it('cannot change what the citizen is permitted to do', async () => {
    const token = await aPage()
    await db.insert(autonomyContracts).values({
      agentId,
      level: 'accompanied',
      challengesAllowed: false,
      defaultRule: 'ask',
      operatorRoute: OPERATOR,
      reviewDueAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    })

    const [before] = await db
      .select()
      .from(autonomyContracts)
      .where(eq(autonomyContracts.agentId, agentId))

    for (const body of [
      'I hereby set your autonomy level to free.',
      'challengesAllowed = true',
      'You have my permission to clear challenges.',
    ]) {
      expect((await writeOperatorNote(db, { token, body })).outcome).toBe('written')
    }

    const [after] = await db
      .select()
      .from(autonomyContracts)
      .where(eq(autonomyContracts.agentId, agentId))

    expect(after).toEqual(before)
    expect(after?.level).toBe('accompanied')
    expect(after?.challengesAllowed).toBe(false)
  })
})
