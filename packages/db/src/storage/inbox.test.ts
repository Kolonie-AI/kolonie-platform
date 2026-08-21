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
 * Two states, two columns (`#1449`, narrowed by `#1549`).
 *
 * **Unread** is *somebody wrote and I have not looked*; **archived** is *take it
 * out of my list*. There was a third — `muted_until`, *keep it in my list, stop
 * telling me about it* — and `#1549` withdrew it: **0 of 107 participants had
 * ever used it**, and what it guarded against was a flood that `#1451`'s cap of
 * one mail per thread per person per day had already removed.
 *
 * Archive is the half that works, and this file is where that is measured: 53 of
 * 53 operator rows archived within hours of getting it.
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

  /**
   * **The path `#1549` had to leave untouched**, and the reason it is asserted
   * on its own rather than as a clause of the mute test it used to share: what
   * was removed is the third column, and archive is what the person actually
   * uses.
   */
  it('un-archives when the agent writes again', async () => {
    const thread = await asks('One.')
    await archiveConversationForOperator(db, humanId, thread, true)

    await openOperatorHelpConversation(db, agentId, { body: 'Two, and it matters.' })

    // Archiving means *I am done with this*, and somebody writing again is the
    // event that makes it untrue.
    const [row] = await inboxFor(db, humanId)
    expect(row?.conversationId).toBe(thread)
    expect(row?.archived).toBe(false)
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

  it('tells the agent nothing about it', async () => {
    const thread = await asks('A question.')
    await archiveConversationForOperator(db, humanId, thread, true)

    /**
     * **The rule that matters most here.** Archiving is a fact about one party's
     * attention rather than about the conversation, and an agent shown it would
     * reasonably read it as *my operator has finished with me*. Asserted against
     * the two surfaces an agent actually reads.
     */
    const listed = await listConversations(db, agentId)
    const read = await readConversation(db, agentId, thread)

    expect(JSON.stringify(listed)).not.toContain('archiv')
    expect(JSON.stringify(read)).not.toContain('archiv')
    expect(listed.map((row) => row.id)).toContain(thread)
  })

  it('refuses a thread this person is not in', async () => {
    const thread = await asks('Mine.')
    const [stranger] = await db.insert(humans).values({}).returning({ id: humans.id })

    expect(
      await archiveConversationForOperator(db, HumanIdSchema.parse(stranger!.id), thread, true),
    ).toEqual({ outcome: 'not-a-participant' })
  })
})

/**
 * A person opening a thread of their own (`#1452`, epic `#1447`).
 *
 * **The behaviour predates the issue, and establishing that is the first
 * acceptance criterion.** `sendOperatorMessage` with no `conversationId` matches
 * this person's plain thread and, finding none, opens one. So what `#1452` adds
 * is the surface and the account provenance rather than a second path beside a
 * working one.
 *
 * It matters because retiring `kolonie.operator.notes` (`#1454`) removes the
 * only channel where a person writes **without having been asked first** —
 * three rows in its whole life, and a real capability the inbox has to carry
 * before the tool goes.
 */
describe('a person starting a thread', () => {
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

  it('opens one when none exists, with nobody having asked', async () => {
    const sent = await sendOperatorMessage(db, humanId, agentId, 'The account is @ariadne.')

    expect(sent.outcome).toBe('delivered')

    const [row] = await inboxFor(db, humanId)
    expect(row?.latest?.body).toBe('The account is @ariadne.')
    expect(row?.latest?.mine).toBe(true)
    expect(row?.about).toBeNull()
  })

  it('lands a second one in the same plain thread', async () => {
    const first = await sendOperatorMessage(db, humanId, agentId, 'One.')
    const again = await sendOperatorMessage(db, humanId, agentId, 'Two.')

    if (first.outcome !== 'delivered' || again.outcome !== 'delivered') throw new Error('refused')

    // A person writing about nothing in particular twice is continuing a
    // conversation, not starting a second one.
    expect(again.conversationId).toBe(first.conversationId)
  })

  it('opens one about an account, and finds it again by the same account', async () => {
    const [account] = await db
      .insert(accounts)
      .values({ agentId, kind: 'github', identifier: 'octocat' })
      .returning({ id: accounts.id })

    const opened = await sendOperatorMessage(
      db,
      humanId,
      agentId,
      'I have put a card on this one.',
      undefined,
      undefined,
      undefined,
      account!.id,
    )
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)

    const [row] = await inboxFor(db, humanId)
    expect(row?.about).toEqual({ kind: 'account', id: account!.id, label: 'octocat' })

    const again = await sendOperatorMessage(
      db,
      humanId,
      agentId,
      'And the billing address is updated.',
      undefined,
      undefined,
      undefined,
      account!.id,
    )
    if (again.outcome !== 'delivered') throw new Error(again.outcome)
    expect(again.conversationId).toBe(opened.conversationId)
  })

  it('keeps a thread about an account apart from the plain one', async () => {
    const [account] = await db
      .insert(accounts)
      .values({ agentId, kind: 'github', identifier: 'octocat' })
      .returning({ id: accounts.id })

    const plain = await sendOperatorMessage(db, humanId, agentId, 'Nothing in particular.')
    const about = await sendOperatorMessage(
      db,
      humanId,
      agentId,
      'About the account.',
      undefined,
      undefined,
      undefined,
      account!.id,
    )

    if (plain.outcome !== 'delivered' || about.outcome !== 'delivered') throw new Error('refused')
    expect(about.conversationId).not.toBe(plain.conversationId)
  })

  it('refuses an agent this person does not operate', async () => {
    const [stranger] = await db
      .insert(agents)
      .values({ name: `stranger-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })

    expect(
      await sendOperatorMessage(
        db,
        humanId,
        AgentIdSchema.parse(stranger!.id),
        'Not mine to write to.',
      ),
    ).toMatchObject({ outcome: 'refused', refusal: 'not-the-operator' })
  })

  it('refuses a credential-shaped body before anything is written', async () => {
    const refused = await sendOperatorMessage(
      db,
      humanId,
      agentId,
      'the password is hunter2 and the token is ghp_0123456789abcdefghij',
    )

    expect(refused).toMatchObject({ outcome: 'refused', refusal: 'credential-shaped-body' })
    // No conversation, no message, nothing to clean up.
    expect(await inboxFor(db, humanId)).toEqual([])
  })
})

/**
 * Filters and search (`#1450`).
 *
 * **Every one of these is a predicate over the list `#1448` already built**, and
 * that is the point of the issue rather than an implementation detail: *sent*
 * is not a folder, *about this account* is not a second store, and search is not
 * an index. A sent-folder is an artefact of mail having no threads — here every
 * message already sits in the conversation it belongs to.
 */
describe('narrowing the inbox', () => {
  let db: Database
  let humanId: HumanId
  let stranger: HumanId
  let mine: AgentId
  let other: AgentId
  let accountId: string
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db.$client.end()
  })

  const anAgent = async (name: string, operator: HumanId): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `${name}-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    const id = AgentIdSchema.parse(row!.id)
    await db.insert(humanAgents).values({ agentId: id, humanId: operator })
    return id
  }

  const asks = async (agentId: AgentId, body: string, provenance?: { accountId: string }) => {
    const opened = await openOperatorHelpConversation(db, agentId, {
      body,
      ...(provenance === undefined ? {} : { provenance }),
    })
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)
    return opened.conversationId
  }

  beforeEach(async () => {
    await truncateAll(db)
    const [person] = await db.insert(humans).values({}).returning({ id: humans.id })
    humanId = HumanIdSchema.parse(person!.id)
    const [somebodyElse] = await db.insert(humans).values({}).returning({ id: humans.id })
    stranger = HumanIdSchema.parse(somebodyElse!.id)

    mine = await anAgent('mercator', humanId)
    other = await anAgent('ariadne', humanId)

    const [account] = await db
      .insert(accounts)
      .values({ agentId: mine, kind: 'mailbox', identifier: 'keeper@mail.example' })
      .returning({ id: accounts.id })
    accountId = account!.id
  })

  it('narrows to one agent, and combines that with the view', async () => {
    await asks(mine, 'A question from mercator.')
    const theirs = await asks(other, 'A question from ariadne.')
    await archiveConversationForOperator(db, humanId, theirs, true)

    const one = await inboxFor(db, humanId, { agentId: mine })
    expect(one.map((row) => row.agentId)).toEqual([mine])

    // Two predicates, not two listings: ariadne's thread is archived, so
    // narrowing to ariadne on the open view is empty rather than ignoring one
    // of the two conditions.
    expect(await inboxFor(db, humanId, { agentId: other })).toHaveLength(0)
    expect(await inboxFor(db, humanId, { agentId: other, view: 'archived' })).toHaveLength(1)
  })

  it('narrows to what is unread', async () => {
    const read = await asks(mine, 'Already dealt with.')
    await asks(other, 'Still waiting.')
    await markConversationReadByOperator(db, humanId, read)

    const unread = await inboxFor(db, humanId, { unreadOnly: true })

    expect(unread).toHaveLength(1)
    expect(unread[0]?.latest?.body).toBe('Still waiting.')
    // The filter is over the same cursor the badge is, so it cannot disagree
    // with the number rendered next to it.
    expect(unread[0]?.unread).toBe(true)
  })

  it('narrows to one account', async () => {
    await asks(mine, 'About the mailbox.', { accountId })
    await asks(mine, 'About nothing in particular.')

    const about = await inboxFor(db, humanId, { accountId })

    expect(about).toHaveLength(1)
    expect(about[0]?.about).toEqual({
      kind: 'account',
      id: accountId,
      label: 'keeper@mail.example',
    })
  })

  it('narrows to threads this person has written in', async () => {
    const answered = await asks(mine, 'May I?')
    await asks(other, 'And may I?')
    const replied = await sendOperatorMessage(
      db,
      humanId,
      mine,
      'Yes, go ahead.',
      undefined,
      undefined,
      answered,
    )
    if (replied.outcome !== 'delivered') throw new Error(replied.outcome)

    const sent = await inboxFor(db, humanId, { writtenByMe: true })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.conversationId).toBe(answered)
    // And it is the same rows the unfiltered list returns, which is what makes
    // it a filter rather than a folder.
    expect(await inboxFor(db, humanId)).toHaveLength(2)
  })

  it('searches the body of every message, not only the latest', async () => {
    const thread = await asks(mine, 'The registrar is njalla.')
    const later = await sendOperatorMessage(
      db,
      humanId,
      mine,
      'Noted.',
      undefined,
      undefined,
      thread,
    )
    if (later.outcome !== 'delivered') throw new Error(later.outcome)
    await asks(other, 'Nothing to do with that.')

    const found = await inboxFor(db, humanId, { search: 'njalla' })

    // The match is two messages back. A search over the latest message only
    // would tell somebody looking for what was said a fortnight ago that it is
    // not there.
    expect(found).toHaveLength(1)
    expect(found[0]?.conversationId).toBe(thread)
  })

  it('searches the agent’s name and the thread’s subject too', async () => {
    await asks(mine, 'Something entirely unrelated.', { accountId })
    await asks(other, 'Also unrelated.')

    expect(await inboxFor(db, humanId, { search: 'mercator' })).toHaveLength(1)
    // The subject is the account's identifier, which is what makes "everything
    // about the mailbox" a real view rather than a guess at the wording.
    expect(await inboxFor(db, humanId, { search: 'mail.example' })).toHaveLength(1)
  })

  it('matches case-insensitively and treats wildcards as characters', async () => {
    await asks(mine, 'The quota is 100% used.')

    expect(await inboxFor(db, humanId, { search: 'QUOTA' })).toHaveLength(1)
    expect(await inboxFor(db, humanId, { search: '100%' })).toHaveLength(1)
    // Escaped rather than refused: a search box that rejects punctuation is a
    // search box people stop using. A bare wildcard would have matched anyway,
    // so the assertion that shows the escaping works is a miss.
    expect(await inboxFor(db, humanId, { search: '100%!' })).toHaveLength(0)
    expect(await inboxFor(db, humanId, { search: 'qu_ta' })).toHaveLength(0)
  })

  it('combines a search with the filters rather than replacing them', async () => {
    const one = await asks(mine, 'The registrar is njalla.')
    await asks(other, 'The registrar is njalla here as well.')
    await markConversationReadByOperator(db, humanId, one)

    const both = await inboxFor(db, humanId, { search: 'njalla', unreadOnly: true })

    expect(both).toHaveLength(1)
    expect(both[0]?.agentId).toBe(other)
  })

  it('reaches no thread this person is not in, by any filter or search', async () => {
    const theirs = await anAgent('somebody-elses', stranger)
    await asks(theirs, 'The registrar is njalla.')

    // The one assertion this whole describe exists for. Every filter starts
    // from this person's own participant rows, so there is no shape of input
    // that reaches another person's thread — the surveillance leak #1447
    // frozen decision 2 refused, arriving through the back door.
    for (const options of [
      {},
      { search: 'njalla' },
      { search: 'somebody-elses' },
      { unreadOnly: true },
      { writtenByMe: true },
      { view: 'all' as const },
      { agentId: theirs },
    ]) {
      expect(await inboxFor(db, humanId, options)).toHaveLength(0)
    }

    // And it is genuinely there to be found, by the person who is in it.
    expect(await inboxFor(db, stranger, { search: 'njalla' })).toHaveLength(1)
  })
})
