import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentIdSchema, HumanIdSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accounts, agents, humanAgents, humans } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  archiveConversationForOperator,
  inboxFor,
  listConversations,
  markConversationReadByOperator,
  muteConversationForOperator,
  openOperatorHelpConversation,
  readConversation,
  sendOperatorMessage,
} from './messaging.js'

const target = databaseTestTarget()

/**
 * A person's inbox, across every agent they operate (`#1448`, epic `#1447`).
 *
 * **The three things this fixes were measured rather than guessed**, in
 * production on 2026-08-20: 52 conversations and 243 messages with a read
 * cursor set on **none** of them; a dashboard that showed only threads nobody
 * had ever answered, so replying once hid a thread for ever; and no route
 * anywhere that listed more than one agent's conversations.
 */
describe('the inbox', () => {
  let db: Database
  let humanId: HumanId
  let first: AgentId
  let second: AgentId
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db.$client.end()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `${name}-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    const id = AgentIdSchema.parse(row!.id)
    await db.insert(humanAgents).values({ agentId: id, humanId })
    return id
  }

  beforeEach(async () => {
    await truncateAll(db)
    const [person] = await db.insert(humans).values({}).returning({ id: humans.id })
    humanId = HumanIdSchema.parse(person!.id)
    first = await anAgent('one')
    second = await anAgent('two')
  })

  const asks = async (agentId: AgentId, body: string, provenance?: { accountId: string }) => {
    const opened = await openOperatorHelpConversation(db, agentId, {
      body,
      ...(provenance === undefined ? {} : { provenance }),
    })
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)
    return opened.conversationId
  }

  it('lists every agent’s threads in one place', async () => {
    await asks(first, 'May I open a mailbox at mail.example?')
    await asks(second, 'Which of these two providers should I use?')

    const inbox = await inboxFor(db, humanId)

    // The defect in one assertion: before this there was no view across agents
    // at all, only `/agents/:agentId/messages` three times over.
    expect(inbox).toHaveLength(2)
    expect(new Set(inbox.map((row) => row.agentName)).size).toBe(2)
  })

  it('orders by activity rather than by when the thread opened', async () => {
    const older = await asks(first, 'Opened first, and quiet since.')
    await asks(second, 'Opened second.')

    // The older thread moves, so it belongs at the top. An inbox ordered by
    // creation is the ordering of an archive.
    const again = await openOperatorHelpConversation(db, first, {
      body: 'And a nudge, two weeks later.',
    })
    if (again.outcome !== 'delivered') throw new Error(again.outcome)
    expect(again.conversationId).toBe(older)

    const inbox = await inboxFor(db, humanId)
    expect(inbox[0]?.conversationId).toBe(older)
  })

  it('shows the latest message and not the first', async () => {
    const thread = await asks(first, 'The opening question, from two weeks ago.')
    await openOperatorHelpConversation(db, first, { body: 'The thing that actually matters now.' })

    const [row] = await inboxFor(db, humanId)

    expect(row?.conversationId).toBe(thread)
    expect(row?.latest?.body).toBe('The thing that actually matters now.')
    expect(row?.latest?.mine).toBe(false)
  })

  it('counts unread from the cursor, and opening the thread clears it', async () => {
    const thread = await asks(first, 'One.')
    await openOperatorHelpConversation(db, first, { body: 'Two.' })

    const before = await inboxFor(db, humanId)
    expect(before[0]).toMatchObject({ unread: true, unreadCount: 2 })

    expect(await markConversationReadByOperator(db, humanId, thread)).toEqual({
      outcome: 'marked',
    })

    const after = await inboxFor(db, humanId)
    expect(after[0]).toMatchObject({ unread: false, unreadCount: 0 })
  })

  it('does not count the person’s own words as unread', async () => {
    const thread = await asks(first, 'A question.')
    await markConversationReadByOperator(db, humanId, thread)

    const sent = await sendOperatorMessage(db, humanId, first, 'An answer from me.')
    if (sent.outcome !== 'delivered') throw new Error(sent.outcome)

    const [row] = await inboxFor(db, humanId)

    // Unread is *from anybody else*. A person's own reply arriving as unread
    // would make the number meaningless within a day.
    expect(row).toMatchObject({ unread: false, unreadCount: 0 })
    expect(row?.latest?.mine).toBe(true)
  })

  it('keeps a thread listed after the person has replied', async () => {
    const thread = await asks(first, 'A question.')
    await sendOperatorMessage(db, humanId, first, 'An answer.')

    /**
     * **The 46-thread defect.** The dashboard's queue filters on *no message
     * from an operator exists*, so replying once removed a thread from it
     * permanently — 46 of 52 were hidden that way, 16 of them with an agent
     * message newer than the operator's last reply.
     */
    const inbox = await inboxFor(db, humanId)
    expect(inbox.map((row) => row.conversationId)).toContain(thread)
  })

  it('carries what the thread is about', async () => {
    const [account] = await db
      .insert(accounts)
      .values({ agentId: first, kind: 'github', identifier: 'octocat' })
      .returning({ id: accounts.id })

    await asks(first, 'please put a card on the GitHub account', { accountId: account!.id })

    const [row] = await inboxFor(db, humanId)
    expect(row?.about).toEqual({ kind: 'account', id: account!.id, label: 'octocat' })
  })

  it('narrows to one agent without changing anything else', async () => {
    await asks(first, 'From the first.')
    await asks(second, 'From the second.')

    const narrowed = await inboxFor(db, humanId, { agentId: second })

    expect(narrowed).toHaveLength(1)
    expect(narrowed[0]?.latest?.body).toBe('From the second.')
  })

  it('shows another person nothing of this one’s', async () => {
    await asks(first, 'A question for my own operator.')

    const [stranger] = await db.insert(humans).values({}).returning({ id: humans.id })

    // Participation is the whole ACL. A person with no participant row has no
    // inbox rows, which is the same refusal every other messaging read makes.
    expect(await inboxFor(db, HumanIdSchema.parse(stranger!.id))).toEqual([])
    expect(
      await markConversationReadByOperator(
        db,
        HumanIdSchema.parse(stranger!.id),
        (await inboxFor(db, humanId))[0]!.conversationId,
      ),
    ).toEqual({ outcome: 'not-a-participant' })
  })
})

/**
 * Three states, three columns, no folding (`#1449`, `#1447` frozen decision 4).
 *
 * The distinction is the design: **unread** is *somebody wrote and I have not
 * looked*, **muted** is *keep it in my list, stop telling me about it*, and
 * **archived** is *take it out of my list*. Folding archive into mute would mean
 * a person who silenced a chatty thread also lost it.
 */
describe('what a person has done with a thread', () => {
  let db: Database
  let humanId: HumanId
  let agentId: AgentId
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db.$client.end()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const [person] = await db.insert(humans).values({}).returning({ id: humans.id })
    humanId = HumanIdSchema.parse(person!.id)

    const [row] = await db
      .insert(agents)
      .values({ name: `keeper-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    agentId = AgentIdSchema.parse(row!.id)
    await db.insert(humanAgents).values({ agentId, humanId })
  })

  const asks = async (body: string) => {
    const opened = await openOperatorHelpConversation(db, agentId, { body })
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)
    return opened.conversationId
  }

  it('takes an archived thread out of the open list and keeps it in the others', async () => {
    const thread = await asks('Something I am finished with.')

    expect(await archiveConversationForOperator(db, humanId, thread, true)).toEqual({
      outcome: 'set',
    })

    expect(await inboxFor(db, humanId)).toEqual([])
    expect((await inboxFor(db, humanId, { view: 'archived' }))[0]?.conversationId).toBe(thread)
    expect((await inboxFor(db, humanId, { view: 'all' }))[0]?.archived).toBe(true)
  })

  it('un-archives when the agent writes again, and does not un-mute', async () => {
    const thread = await asks('One.')
    await archiveConversationForOperator(db, humanId, thread, true)
    await muteConversationForOperator(db, humanId, thread, '2999-01-01T00:00:00.000Z')

    await openOperatorHelpConversation(db, agentId, { body: 'Two, and it matters.' })

    /**
     * Archiving means *I am done with this*, and somebody writing again is the
     * event that makes it untrue. Mute means *stop telling me*, and survives
     * exactly the event archive does not — which is why they are two columns.
     */
    const [row] = await inboxFor(db, humanId)
    expect(row?.conversationId).toBe(thread)
    expect(row?.archived).toBe(false)
    expect(row?.mutedUntil).not.toBeNull()
  })

  it('leaves a muted thread in the list, still showing unread', async () => {
    const thread = await asks('Chatty.')
    await muteConversationForOperator(db, humanId, thread, '2999-01-01T00:00:00.000Z')

    const [row] = await inboxFor(db, humanId)

    expect(row?.conversationId).toBe(thread)
    expect(row?.unread).toBe(true)
    expect(row?.mutedUntil).not.toBeNull()
  })

  it('does not mark read, and reading does not archive', async () => {
    const thread = await asks('Unread and finished with.')

    await archiveConversationForOperator(db, humanId, thread, true)
    expect((await inboxFor(db, humanId, { view: 'archived' }))[0]?.unread).toBe(true)

    await archiveConversationForOperator(db, humanId, thread, false)
    await markConversationReadByOperator(db, humanId, thread)

    const [row] = await inboxFor(db, humanId)
    expect(row?.unread).toBe(false)
    expect(row?.archived).toBe(false)
  })

  it('does not un-archive for the person who wrote the message', async () => {
    const thread = await asks('A question.')
    await archiveConversationForOperator(db, humanId, thread, true)

    await sendOperatorMessage(db, humanId, agentId, 'Answered, and still finished with it.')

    // A person who archived a thread and then wrote one more line into it has
    // not changed their mind about being finished; they answered and moved on.
    expect(await inboxFor(db, humanId)).toEqual([])
  })

  it('tells the agent nothing about either', async () => {
    const thread = await asks('A question.')
    await archiveConversationForOperator(db, humanId, thread, true)
    await muteConversationForOperator(db, humanId, thread, '2999-01-01T00:00:00.000Z')

    /**
     * **The rule that matters most here.** An agent that learned it had been
     * muted would reasonably open a second thread, which is exactly what muting
     * was for. Asserted against the two surfaces an agent actually reads.
     */
    const listed = await listConversations(db, agentId)
    const read = await readConversation(db, agentId, thread)

    expect(JSON.stringify(listed)).not.toContain('archiv')
    expect(JSON.stringify(listed)).not.toContain('mute')
    expect(JSON.stringify(read)).not.toContain('archiv')
    expect(JSON.stringify(read)).not.toContain('mute')
    expect(listed.map((row) => row.id)).toContain(thread)
  })

  it('refuses a thread this person is not in', async () => {
    const thread = await asks('Mine.')
    const [stranger] = await db.insert(humans).values({}).returning({ id: humans.id })

    expect(
      await archiveConversationForOperator(db, HumanIdSchema.parse(stranger!.id), thread, true),
    ).toEqual({ outcome: 'not-a-participant' })
    expect(
      await muteConversationForOperator(db, HumanIdSchema.parse(stranger!.id), thread, null),
    ).toEqual({ outcome: 'not-a-participant' })
  })
})
