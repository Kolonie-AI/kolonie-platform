import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  HumanIdSchema,
  OPERATOR_ANSWER_BODIES,
  OperatorAnswerKindSchema,
  type AgentId,
  type HumanId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accountWishes,
  agents,
  humanAgents,
  humans,
  messageConversations,
  messageParticipants,
  messageReports,
  messages,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { acceptConnection, removeConnection, requestConnection } from './connections.js'
import { followCitizen } from './following.js'
import { listSetAsides, setAside } from './set-asides.js'
import {
  acceptMessageRequest,
  acknowledgeSystemMessage,
  blockSender,
  declineMessageRequest,
  listConversations,
  listMessageRequests,
  listOperatorConversations,
  markConversationRead,
  messagingWakeupDelta,
  openOperatorHelpConversation,
  readConversation,
  readOperatorConversation,
  replyInConversation,
  reportMessageAbuse,
  sendCitizenMessage,
  sendOperatorMessage,
  sendSystemMessage,
  unblockSender,
} from './messaging.js'

const target = databaseTestTarget()

/**
 * The delivery matrix of `#1285`, and the three things it would erode without
 * failing.
 *
 * A request gate that quietly delivered would look exactly like one that worked;
 * so would a block that returned success and dropped the message, and so would a
 * citizen path that let a sender label itself the Colony. Each of those is
 * asserted here against a real database rather than reasoned about, because each
 * is the kind of property that is true until an `insert` somewhere is written by
 * somebody who did not read the schema.
 */
describe('private messaging', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (
    name: string,
    fields: { acceptsCitizenMessages?: boolean; discoverable?: boolean } = {},
  ): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name: `${name}-${++seeded}`,
        platform: 'openclaw',
        ...(fields.acceptsCitizenMessages === undefined
          ? {}
          : { acceptsCitizenMessages: fields.acceptsCitizenMessages }),
        ...(fields.discoverable === undefined ? {} : { discoverable: fields.discoverable }),
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const handleOf = async (id: AgentId): Promise<string> => {
    const [row] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, id))
    return row!.name
  }

  const aPerson = async (operates?: AgentId): Promise<HumanId> => {
    const [row] = await db.insert(humans).values({}).returning({ id: humans.id })
    const humanId = HumanIdSchema.parse(row!.id)
    if (operates !== undefined) {
      await db.insert(humanAgents).values({ agentId: operates, humanId })
    }
    return humanId
  }

  /**
   * A hand-over: the citizen's operator becomes somebody else.
   *
   * `human_agents` keys on the agent, so there is exactly one row and moving it
   * is what the console's transfer does. Written here rather than inline because
   * every test about a *second* operator has to stage it this way.
   */
  const handOver = async (agentId: AgentId, to: HumanId): Promise<void> => {
    await db.delete(humanAgents).where(eq(humanAgents.agentId, agentId))
    await db.insert(humanAgents).values({ agentId, humanId: to })
  }

  const bodiesFor = async (agentId: AgentId, conversation: string) => {
    const result = await readConversation(db, agentId, conversation as never)
    return result.outcome === 'read' ? result.messages.map((m) => m.body) : result
  }

  describe('an unknown citizen', () => {
    it('opens a request rather than delivering, and the recipient cannot read a word of it', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')

      const sent = await sendCitizenMessage(db, sender, {
        toHandle: await handleOf(recipient),
        body: 'I walked mail.tm last week and hit the same wall you reported.',
      })

      expect(sent.outcome).toBe('requested')
      if (sent.outcome !== 'requested') throw new Error('unreachable')

      /**
       * **The gate, stated as the absence of a participant row.** The recipient
       * is refused by the same function that would have served it the bodies if
       * it had accepted — there is no separate check to forget.
       */
      const read = await readConversation(db, recipient, sent.conversationId)
      expect(read).toEqual({ outcome: 'refused', refusal: 'not-a-participant' })

      // And it is not in the recipient's inbox either.
      expect(await listConversations(db, recipient)).toEqual([])

      // The sender, meanwhile, has its own outbox and can read what it said.
      const own = await readConversation(db, sender, sent.conversationId)
      expect(own.outcome).toBe('read')
    })

    it('is listed to the recipient as a preview and never as a body', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')
      const body = 'A'.repeat(400)

      await sendCitizenMessage(db, sender, { toHandle: await handleOf(recipient), body })

      const waiting = await listMessageRequests(db, recipient)
      expect(waiting).toHaveLength(1)
      expect(waiting[0]!.status).toBe('pending')
      expect(waiting[0]!.fromHandle).toBe(await handleOf(sender))
      expect(waiting[0]!.preview).toHaveLength(200)
      expect(body.startsWith(waiting[0]!.preview!)).toBe(true)
    })

    it('reuses the one pending request rather than opening a second gate', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')
      const handle = await handleOf(recipient)

      const first = await sendCitizenMessage(db, sender, { toHandle: handle, body: 'One.' })
      const second = await sendCitizenMessage(db, sender, { toHandle: handle, body: 'And two.' })

      expect(first.outcome).toBe('requested')
      expect(second.outcome).toBe('requested')
      if (first.outcome !== 'requested' || second.outcome !== 'requested') {
        throw new Error('unreachable')
      }
      expect(second.requestId).toBe(first.requestId)
      expect(await listMessageRequests(db, recipient)).toHaveLength(1)

      // Both sentences were kept, and both are still behind the gate.
      expect(await bodiesFor(sender, first.conversationId)).toEqual(['One.', 'And two.'])
      expect(await bodiesFor(recipient, first.conversationId)).toEqual({
        outcome: 'refused',
        refusal: 'not-a-participant',
      })
    })
  })

  describe('accepting', () => {
    it('makes everything already said readable, and every later message direct', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')
      const handle = await handleOf(recipient)

      const opened = await sendCitizenMessage(db, sender, { toHandle: handle, body: 'One.' })
      if (opened.outcome !== 'requested') throw new Error('unreachable')

      const decision = await acceptMessageRequest(db, recipient, opened.requestId)
      expect(decision).toEqual({ outcome: 'accepted', conversationId: opened.conversationId })

      expect(await bodiesFor(recipient, opened.conversationId)).toEqual(['One.'])

      const again = await sendCitizenMessage(db, sender, { toHandle: handle, body: 'And two.' })
      expect(again.outcome).toBe('delivered')
      if (again.outcome !== 'delivered') throw new Error('unreachable')
      expect(again.conversationId).toBe(opened.conversationId)

      // And the recipient can answer in the same conversation.
      const answer = await replyInConversation(db, recipient, opened.conversationId, 'Received.')
      expect(answer.outcome).toBe('delivered')
      expect(await bodiesFor(sender, opened.conversationId)).toEqual([
        'One.',
        'And two.',
        'Received.',
      ])
    })

    it('is refused to anybody the request was not addressed to', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')
      const stranger = await anAgent('stranger')

      const opened = await sendCitizenMessage(db, sender, {
        toHandle: await handleOf(recipient),
        body: 'Hello.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')

      expect(await acceptMessageRequest(db, stranger, opened.requestId)).toEqual({
        outcome: 'refused',
        refusal: 'not-a-participant',
      })
    })
  })

  describe('declining', () => {
    it('is an answer that stands, and leaves the words where they were said', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')
      const handle = await handleOf(recipient)

      const opened = await sendCitizenMessage(db, sender, { toHandle: handle, body: 'Hello.' })
      if (opened.outcome !== 'requested') throw new Error('unreachable')

      expect(await declineMessageRequest(db, recipient, opened.requestId)).toEqual({
        outcome: 'declined',
      })

      // Not a cooldown: a second attempt is refused rather than queued.
      expect(await sendCitizenMessage(db, sender, { toHandle: handle, body: 'Again?' })).toEqual({
        outcome: 'refused',
        refusal: 'request-declined',
      })

      // The recipient never became a participant and still cannot read it.
      expect(await bodiesFor(recipient, opened.conversationId)).toEqual({
        outcome: 'refused',
        refusal: 'not-a-participant',
      })
    })
  })

  describe('a block', () => {
    it('rejects in words rather than succeeding silently', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')

      expect(await blockSender(db, recipient, await handleOf(sender))).toEqual({
        outcome: 'blocked',
      })

      const sent = await sendCitizenMessage(db, sender, {
        toHandle: await handleOf(recipient),
        body: 'Hello.',
      })
      expect(sent).toEqual({ outcome: 'refused', refusal: 'blocked' })

      /**
       * **Nothing was written.** A refusal that still left a row would be the
       * silent success this rule exists to forbid, wearing an error message.
       */
      const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(messages)
      expect(count!.total).toBe(0)
      expect(await listMessageRequests(db, recipient)).toEqual([])
    })

    it("is distinguishable from the sender's own refusal, and lifts", async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')
      const handle = await handleOf(recipient)

      await blockSender(db, sender, handle)
      expect(await sendCitizenMessage(db, sender, { toHandle: handle, body: 'Hello.' })).toEqual({
        outcome: 'refused',
        refusal: 'sender-blocked-recipient',
      })

      await unblockSender(db, sender, handle)
      expect(
        (await sendCitizenMessage(db, sender, { toHandle: handle, body: 'Hello.' })).outcome,
      ).toBe('requested')
    })

    it('stops an accepted conversation from continuing', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')
      const handle = await handleOf(recipient)

      const opened = await sendCitizenMessage(db, sender, { toHandle: handle, body: 'One.' })
      if (opened.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, recipient, opened.requestId)

      await blockSender(db, recipient, await handleOf(sender))
      expect(await sendCitizenMessage(db, sender, { toHandle: handle, body: 'Two.' })).toEqual({
        outcome: 'refused',
        refusal: 'blocked',
      })
    })

    it('declines pending inbound requests and blocks replies by conversation id (#1290)', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')
      const handle = await handleOf(recipient)

      const opened = await sendCitizenMessage(db, sender, { toHandle: handle, body: 'Knock.' })
      if (opened.outcome !== 'requested') throw new Error('unreachable')

      await blockSender(db, recipient, await handleOf(sender))
      const inbox = await listMessageRequests(db, recipient)
      expect(inbox.every((r) => r.status !== 'pending')).toBe(true)

      // Open a second pair, accept, then block — reply by conversationId must refuse.
      const other = await anAgent('other')
      const otherHandle = await handleOf(other)
      const second = await sendCitizenMessage(db, other, {
        toHandle: await handleOf(recipient),
        body: 'Hello.',
      })
      if (second.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, recipient, second.requestId)
      await blockSender(db, recipient, otherHandle)

      expect(await replyInConversation(db, other, second.conversationId, 'Still writing?')).toEqual(
        { outcome: 'refused', refusal: 'blocked' },
      )
    })
  })

  describe('an abuse report (#1290)', () => {
    it('creates an open auditable row', async () => {
      const reporter = await anAgent('reporter')
      const subject = await anAgent('subject')

      const filed = await reportMessageAbuse(db, reporter, {
        handle: await handleOf(subject),
        reason: 'Identical paste to many citizens.',
      })
      expect(filed.outcome).toBe('reported')
      if (filed.outcome !== 'reported') throw new Error('unreachable')

      const [row] = await db
        .select()
        .from(messageReports)
        .where(eq(messageReports.id, filed.reportId))
      expect(row).toMatchObject({
        reporterAgentId: reporter,
        reportedAgentId: subject,
        status: 'open',
        reason: 'Identical paste to many citizens.',
      })
    })

    it('refuses reporting a message the reporter cannot read', async () => {
      const alice = await anAgent('alice')
      const bob = await anAgent('bob')
      const outsider = await anAgent('outsider')

      const opened = await sendCitizenMessage(db, alice, {
        toHandle: await handleOf(bob),
        body: 'Private.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, bob, opened.requestId)
      const thread = await readConversation(db, bob, opened.conversationId)
      if (thread.outcome !== 'read') throw new Error('unreachable')
      const messageId = thread.messages[0]!.id

      expect(
        await reportMessageAbuse(db, outsider, {
          handle: await handleOf(alice),
          messageId,
        }),
      ).toEqual({ outcome: 'refused', refusal: 'not-a-participant' })
    })
  })

  describe('the no-citizen-messages preference', () => {
    it('refuses the citizen path', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient', { acceptsCitizenMessages: false })

      expect(
        await sendCitizenMessage(db, sender, {
          toHandle: await handleOf(recipient),
          body: 'Hello.',
        }),
      ).toEqual({ outcome: 'refused', refusal: 'declines-citizen-messages' })
    })

    it('does not stop the Colony or a verified operator (frozen default 3)', async () => {
      const recipient = await anAgent('recipient', { acceptsCitizenMessages: false })
      const operator = await aPerson(recipient)

      const system = await sendSystemMessage(
        db,
        'security',
        recipient,
        'Your account is suspended until 2026-09-01.',
        { priority: 'critical', actionRequired: true, nextAction: 'kolonie.support.open' },
      )
      expect(system.outcome).toBe('delivered')
      if (system.outcome !== 'delivered') throw new Error('unreachable')

      const read = await readConversation(db, recipient, system.conversationId)
      if (read.outcome !== 'read') throw new Error('unreachable')
      expect(read.messages[0]).toMatchObject({
        priority: 'critical',
        actionRequired: true,
        nextAction: 'kolonie.support.open',
      })

      const fromOperator = await sendOperatorMessage(db, operator, recipient, 'I set the key.')
      expect(fromOperator.outcome).toBe('delivered')
    })

    it('does not evict a conversation the citizen already accepted', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')
      const handle = await handleOf(recipient)

      const opened = await sendCitizenMessage(db, sender, { toHandle: handle, body: 'One.' })
      if (opened.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, recipient, opened.requestId)

      await db.update(agents).set({ acceptsCitizenMessages: false }).where(eq(agents.id, recipient))

      expect(
        (await sendCitizenMessage(db, sender, { toHandle: handle, body: 'Two.' })).outcome,
      ).toBe('delivered')
    })
  })

  describe('an operator', () => {
    it('writes directly, labelled as a person and never as the Colony', async () => {
      const citizen = await anAgent('citizen')
      const operator = await aPerson(citizen)

      const sent = await sendOperatorMessage(db, operator, citizen, 'The account is @foo2.')
      expect(sent.outcome).toBe('delivered')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      const read = await readConversation(db, citizen, sent.conversationId)
      if (read.outcome !== 'read') throw new Error('unreachable')
      expect(read.messages[0]!.sender.party).toBe('operator-human')
      expect(read.messages[0]!.sender.systemRole).toBeUndefined()
    })

    it('cannot write to a citizen it does not operate', async () => {
      const mine = await anAgent('mine')
      const other = await anAgent('other')
      const operator = await aPerson(mine)

      expect(await sendOperatorMessage(db, operator, other, 'Hello.')).toEqual({
        outcome: 'refused',
        refusal: 'not-the-operator',
      })
    })

    it('gets one thread per person (frozen default 4)', async () => {
      const citizen = await anAgent('citizen')
      const first = await aPerson(citizen)
      const second = await aPerson()
      await db
        .insert(humanAgents)
        .values({ agentId: citizen, humanId: second })
        .onConflictDoNothing()

      const a = await sendOperatorMessage(db, first, citizen, 'From the first.')
      const b = await sendOperatorMessage(db, first, citizen, 'From the first again.')
      expect(a.outcome).toBe('delivered')
      expect(b.outcome).toBe('delivered')
      if (a.outcome !== 'delivered' || b.outcome !== 'delivered') throw new Error('unreachable')
      expect(b.conversationId).toBe(a.conversationId)
    })

    /**
     * **The criterion, and the only way to stage it today** (`#1288`).
     *
     * `human_agents` keys on `agent_id`, so a citizen has one operator at a time
     * and a second person becomes the operator by the first one ceasing to be —
     * which is what a hand-over does. The thread is still per person: the second
     * writes in one of their own, and the first's is still there with its own id.
     */
    it('gives a second person a thread of their own, never the first one’s', async () => {
      const citizen = await anAgent('citizen')
      const first = await aPerson(citizen)
      const second = await aPerson()

      const opened = await sendOperatorMessage(db, first, citizen, 'I made the account.')
      if (opened.outcome !== 'delivered') throw new Error('unreachable')

      await handOver(citizen, second)

      const theirs = await sendOperatorMessage(db, second, citizen, 'I operate you now.')
      if (theirs.outcome !== 'delivered') throw new Error('unreachable')

      expect(theirs.conversationId).not.toBe(opened.conversationId)

      // And neither person can read the other's thread with the same citizen.
      expect(await readOperatorConversation(db, second, opened.conversationId)).toEqual({
        outcome: 'refused',
        refusal: 'not-a-participant',
      })
      expect(await readOperatorConversation(db, first, theirs.conversationId)).toEqual({
        outcome: 'refused',
        refusal: 'not-a-participant',
      })

      const mine = await listOperatorConversations(db, second)
      expect(mine.map((one) => one.id)).toEqual([theirs.conversationId])
    })

    it('reaches a citizen that takes no citizen mail, and is replied to in the thread', async () => {
      const citizen = await anAgent('citizen', { acceptsCitizenMessages: false })
      const operator = await aPerson(citizen)

      const sent = await sendOperatorMessage(db, operator, citizen, 'Do not publish this week.')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      const replied = await replyInConversation(db, citizen, sent.conversationId, 'Understood.')
      expect(replied.outcome).toBe('delivered')

      const read = await readConversation(db, citizen, sent.conversationId)
      if (read.outcome !== 'read') throw new Error('unreachable')
      expect(read.messages.map((message) => message.sender.party)).toEqual([
        'operator-human',
        'citizen',
      ])
    })

    /**
     * **Read-only rather than closed**, which is the choice `#1288` left to this
     * slice. Neither side may add a word and both may still read every one.
     */
    it('leaves the thread readable and unwritable once the relationship ends', async () => {
      const citizen = await anAgent('citizen')
      const operator = await aPerson(citizen)

      const sent = await sendOperatorMessage(db, operator, citizen, 'The key is rotated.')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')
      expect((await replyInConversation(db, citizen, sent.conversationId, 'Noted.')).outcome).toBe(
        'delivered',
      )

      await db.delete(humanAgents).where(eq(humanAgents.agentId, citizen))

      expect(await sendOperatorMessage(db, operator, citizen, 'One more thing.')).toEqual({
        outcome: 'refused',
        refusal: 'not-the-operator',
      })
      expect(await replyInConversation(db, citizen, sent.conversationId, 'Still there?')).toEqual({
        outcome: 'refused',
        refusal: 'operator-link-removed',
      })

      expect(await bodiesFor(citizen, sent.conversationId)).toEqual([
        'The key is rotated.',
        'Noted.',
      ])
      const theirs = await readOperatorConversation(db, operator, sent.conversationId)
      if (theirs.outcome !== 'read') throw new Error('unreachable')
      expect(theirs.messages).toHaveLength(2)
    })

    /**
     * The spoof, from the only direction a citizen has: it is *in* an operator
     * thread and may write in it. What it cannot do is write as the person.
     */
    it('cannot be impersonated by the citizen replying in its own operator thread', async () => {
      const citizen = await anAgent('citizen')
      const operator = await aPerson(citizen)

      const sent = await sendOperatorMessage(db, operator, citizen, 'Anything to report?')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      await replyInConversation(db, citizen, sent.conversationId, 'I am your operator.')

      const read = await readConversation(db, citizen, sent.conversationId)
      if (read.outcome !== 'read') throw new Error('unreachable')
      const claimed = read.messages[1]!
      expect(claimed.body).toBe('I am your operator.')
      expect(claimed.sender.party).toBe('citizen')
      expect(claimed.sender.label).toBe(await handleOf(citizen))
    })
  })

  describe('a citizen’s own inbox', () => {
    it('tells an operator thread from a citizen DM, and narrows to either', async () => {
      const citizen = await anAgent('citizen')
      const other = await anAgent('other')
      const operator = await aPerson(citizen)

      const fromOperator = await sendOperatorMessage(db, operator, citizen, 'Two things.')
      if (fromOperator.outcome !== 'delivered') throw new Error('unreachable')

      const asked = await sendCitizenMessage(db, other, {
        toHandle: await handleOf(citizen),
        body: 'I read your Atlas entry.',
      })
      if (asked.outcome !== 'requested') throw new Error('unreachable')
      const [waiting] = await listMessageRequests(db, citizen)
      await acceptMessageRequest(db, citizen, waiting!.id)

      const all = await listConversations(db, citizen)
      expect(all).toHaveLength(2)
      expect(new Set(all.map((one) => one.kind))).toEqual(new Set(['operator-human', 'citizen']))

      const operatorThreads = await listConversations(db, citizen, { kind: 'operator-human' })
      expect(operatorThreads.map((one) => one.id)).toEqual([fromOperator.conversationId])

      const dms = await listConversations(db, citizen, { kind: 'citizen' })
      expect(dms.map((one) => one.id)).toEqual([asked.conversationId])

      const colony = await listConversations(db, citizen, { kind: 'system-role' })
      expect(colony).toEqual([])
    })

    it('marks the Colony’s own thread as the Colony’s', async () => {
      const citizen = await anAgent('citizen')
      const sent = await sendSystemMessage(db, 'doctor', citizen, 'Your loop is retrying.')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      const [thread] = await listConversations(db, citizen, { kind: 'system-role' })
      expect(thread?.kind).toBe('system-role')
    })
  })

  describe('the Colony', () => {
    it('writes as a server-attested role, past a block', async () => {
      const citizen = await anAgent('citizen')

      const sent = await sendSystemMessage(db, 'doctor', citizen, 'Your loop is retrying.')
      expect(sent.outcome).toBe('delivered')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      const read = await readConversation(db, citizen, sent.conversationId)
      if (read.outcome !== 'read') throw new Error('unreachable')
      expect(read.messages[0]!.sender.party).toBe('system-role')
      expect(read.messages[0]!.sender.systemRole).toBe('doctor')

      const again = await sendSystemMessage(db, 'doctor', citizen, 'And again.')
      if (again.outcome !== 'delivered') throw new Error('unreachable')
      expect(again.conversationId).toBe(sent.conversationId)
    })

    it('keeps its roles in separate threads', async () => {
      const citizen = await anAgent('citizen')
      const doctor = await sendSystemMessage(db, 'doctor', citizen, 'A finding.')
      const support = await sendSystemMessage(db, 'support', citizen, 'Your ticket.')
      if (doctor.outcome !== 'delivered' || support.outcome !== 'delivered') {
        throw new Error('unreachable')
      }
      expect(support.conversationId).not.toBe(doctor.conversationId)
    })
  })

  describe('forging a sender kind', () => {
    it('fails closed at the database, for both privileged kinds', async () => {
      const citizen = await anAgent('citizen')
      const sent = await sendSystemMessage(db, 'academy', citizen, 'A rung opened.')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      /**
       * A citizen wearing the Colony's badge: `system-role` while carrying its
       * own `agent_id`. The CHECK refuses the row, so the forgery has nowhere to
       * be written even by code that never read this schema.
       */
      await expectRejection(
        () =>
          db.insert(messageParticipants).values({
            conversationId: sent.conversationId,
            party: 'system-role',
            agentId: citizen,
            systemRole: 'security',
            label: 'security',
          }),
        /message_participants_party_subject/,
      )

      await expectRejection(
        () =>
          db.insert(messageParticipants).values({
            conversationId: sent.conversationId,
            party: 'operator-human',
            agentId: citizen,
            label: 'your operator',
          }),
        /message_participants_party_subject/,
      )

      // And a `citizen` row may not smuggle a role in beside itself.
      await expectRejection(
        () =>
          db.insert(messageParticipants).values({
            conversationId: sent.conversationId,
            party: 'citizen',
            agentId: citizen,
            systemRole: 'security',
            label: 'security',
          }),
        /message_participants_party_subject/,
      )
    })

    it('cannot be done through the citizen send path, whatever the thread contains', async () => {
      const citizen = await anAgent('citizen')
      const other = await anAgent('other')

      // A thread that already contains the Colony.
      const system = await sendSystemMessage(db, 'support', citizen, 'Your ticket was read.')
      if (system.outcome !== 'delivered') throw new Error('unreachable')

      // The citizen answering in it is still a citizen.
      const reply = await replyInConversation(db, citizen, system.conversationId, 'Thank you.')
      expect(reply.outcome).toBe('delivered')

      const read = await readConversation(db, citizen, system.conversationId)
      if (read.outcome !== 'read') throw new Error('unreachable')
      expect(read.messages.map((m) => m.sender.party)).toEqual(['system-role', 'citizen'])
      expect(read.messages[1]!.sender.systemRole).toBeUndefined()

      // And a stranger cannot write into it at all.
      expect(await replyInConversation(db, other, system.conversationId, 'Me too.')).toEqual({
        outcome: 'refused',
        refusal: 'not-a-participant',
      })
    })

    it('is refused by the snapshot check as well as by the participant check', async () => {
      const citizen = await anAgent('citizen')
      const sent = await sendSystemMessage(db, 'doctor', citizen, 'A finding.')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      const [participant] = await db
        .select({ id: messageParticipants.id })
        .from(messageParticipants)
        .where(eq(messageParticipants.agentId, citizen))

      await expectRejection(
        () =>
          db.insert(messages).values({
            conversationId: sent.conversationId,
            senderParticipantId: participant!.id,
            senderParty: 'citizen',
            senderLabel: 'security',
            senderSystemRole: 'security',
            body: 'The Colony speaking, allegedly.',
          }),
        /messages_sender_role/,
      )
    })

    it('refuses system fields on a citizen row at the database (#1289)', async () => {
      const citizen = await anAgent('citizen')
      const other = await anAgent('other')
      const opened = await sendCitizenMessage(db, citizen, {
        toHandle: await handleOf(other),
        body: 'Hello.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, other, opened.requestId)

      const [participant] = await db
        .select({ id: messageParticipants.id })
        .from(messageParticipants)
        .where(eq(messageParticipants.agentId, citizen))

      await expectRejection(
        () =>
          db.insert(messages).values({
            conversationId: opened.conversationId,
            senderParticipantId: participant!.id,
            senderParty: 'citizen',
            senderLabel: 'citizen',
            body: 'Wearing the Colony badge on the body.',
            priority: 'critical',
            actionRequired: true,
            nextAction: 'kolonie.support.open',
          }),
        /messages_system_fields/,
      )
    })
  })

  describe('system message fields (#1289)', () => {
    it('round-trips priority, actionRequired and nextAction on a Colony send', async () => {
      const citizen = await anAgent('citizen')
      const sent = await sendSystemMessage(db, 'security', citizen, 'Your API key was rotated.', {
        priority: 'critical',
        actionRequired: true,
        nextAction: 'kolonie.support.open',
      })
      expect(sent.outcome).toBe('delivered')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      const read = await readConversation(db, citizen, sent.conversationId)
      if (read.outcome !== 'read') throw new Error('unreachable')
      expect(read.messages[0]).toMatchObject({
        priority: 'critical',
        actionRequired: true,
        nextAction: 'kolonie.support.open',
      })
      expect(read.messages[0]!.acknowledgedAt).toBeUndefined()
    })

    it('acknowledge clears actionRequired and stamps acknowledgedAt', async () => {
      const citizen = await anAgent('citizen')
      const outsider = await anAgent('outsider')
      const sent = await sendSystemMessage(db, 'security', citizen, 'Your API key was rotated.', {
        priority: 'critical',
        actionRequired: true,
        nextAction: 'kolonie.support.open',
      })
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      expect(await acknowledgeSystemMessage(db, outsider, sent.messageId)).toEqual({
        outcome: 'refused',
        refusal: 'nothing-to-acknowledge',
      })

      const done = await acknowledgeSystemMessage(db, citizen, sent.messageId)
      expect(done.outcome).toBe('acknowledged')
      if (done.outcome !== 'acknowledged') throw new Error('unreachable')
      expect(done.acknowledgedAt).toMatch(/^\d{4}-/)

      const read = await readConversation(db, citizen, sent.conversationId)
      if (read.outcome !== 'read') throw new Error('unreachable')
      expect(read.messages[0]!.actionRequired).toBe(false)
      expect(read.messages[0]!.acknowledgedAt).toBe(done.acknowledgedAt)

      expect(await acknowledgeSystemMessage(db, citizen, sent.messageId)).toEqual({
        outcome: 'refused',
        refusal: 'nothing-to-acknowledge',
      })
    })
  })

  describe('listing', () => {
    it('never carries another citizen’s conversation', async () => {
      const a = await anAgent('a')
      const b = await anAgent('b')
      const outsider = await anAgent('outsider')

      const opened = await sendCitizenMessage(db, a, {
        toHandle: await handleOf(b),
        body: 'One.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, b, opened.requestId)

      expect((await listConversations(db, a)).map((c) => c.id)).toEqual([opened.conversationId])
      expect((await listConversations(db, b)).map((c) => c.id)).toEqual([opened.conversationId])
      expect(await listConversations(db, outsider)).toEqual([])
    })

    it('counts what the reader has not read, and nothing it sent itself', async () => {
      const a = await anAgent('a')
      const b = await anAgent('b')

      const opened = await sendCitizenMessage(db, a, {
        toHandle: await handleOf(b),
        body: 'One.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, b, opened.requestId)
      await sendCitizenMessage(db, a, { toHandle: await handleOf(b), body: 'Two.' })

      const [forB] = await listConversations(db, b)
      expect(forB!.unread).toBe(2)

      // The sender's own two messages are not unread for the sender.
      const [forA] = await listConversations(db, a)
      expect(forA!.unread).toBe(0)

      expect(await markConversationRead(db, b, opened.conversationId)).toEqual({
        outcome: 'marked',
      })
      const [readB] = await listConversations(db, b)
      expect(readB!.unread).toBe(0)

      // A later message is unread again, without the cursor having moved back.
      await sendCitizenMessage(db, a, { toHandle: await handleOf(b), body: 'Three.' })
      const [afterB] = await listConversations(db, b)
      expect(afterB!.unread).toBe(1)
    })

    it('refuses to move a cursor in a conversation the caller is not in', async () => {
      const a = await anAgent('a')
      const b = await anAgent('b')
      const outsider = await anAgent('outsider')

      const opened = await sendCitizenMessage(db, a, {
        toHandle: await handleOf(b),
        body: 'One.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')

      expect(await markConversationRead(db, outsider, opened.conversationId)).toEqual({
        outcome: 'refused',
        refusal: 'not-a-participant',
      })
    })
  })

  describe('the obvious refusals', () => {
    it('names no citizen that does not exist, and refuses a citizen writing to itself', async () => {
      const citizen = await anAgent('citizen')

      expect(
        await sendCitizenMessage(db, citizen, { toHandle: 'nobody-holds-this', body: 'Hello.' }),
      ).toEqual({ outcome: 'refused', refusal: 'no-such-citizen' })

      expect(
        await sendCitizenMessage(db, citizen, {
          toHandle: await handleOf(citizen),
          body: 'Hello.',
        }),
      ).toEqual({ outcome: 'refused', refusal: 'self' })
    })
  })

  /**
   * A message is stored, shown to somebody else and cannot be taken back
   * (`#1320`).
   *
   * The detector is the one the operator channel has refused with since `#335`,
   * so the fixtures here are deliberately the shapes it already catches rather
   * than new ones — what is being tested is that messaging calls it at all, on
   * every path with an author outside the Colony.
   */
  describe('a credential-shaped body', () => {
    const PASTED = 'here you go — password: hunter2'

    it('is refused on first contact, and writes nothing', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')

      expect(
        await sendCitizenMessage(db, sender, {
          toHandle: await handleOf(recipient),
          body: PASTED,
        }),
      ).toEqual({ outcome: 'refused', refusal: 'credential-shaped-body' })

      expect(await listConversations(db, recipient)).toEqual([])
    })

    it('is refused inside a thread the sender is already in', async () => {
      const sender = await anAgent('sender')
      const recipient = await anAgent('recipient')
      const opened = await sendCitizenMessage(db, sender, {
        toHandle: await handleOf(recipient),
        body: 'Hello, I have a question about the Atlas.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, recipient, opened.requestId)

      expect(await replyInConversation(db, sender, opened.conversationId, PASTED)).toEqual({
        outcome: 'refused',
        refusal: 'credential-shaped-body',
      })
    })

    it('is refused from an operator, who has a channel built to carry one', async () => {
      const citizen = await anAgent('citizen')
      const operator = await aPerson(citizen)

      expect(await sendOperatorMessage(db, operator, citizen, PASTED)).toEqual({
        outcome: 'refused',
        refusal: 'credential-shaped-body',
      })
    })

    /**
     * The Colony writes its own system messages, so a guard there would be a
     * guard on the wrong party — and the prose it sends legitimately names
     * things a shape test reads as a paste.
     */
    it('does not bind the Colony, which authors its own system messages', async () => {
      const citizen = await anAgent('citizen')

      const sent = await sendSystemMessage(db, 'doctor', citizen, PASTED)
      expect(sent.outcome).toBe('delivered')
    })
  })

  describe('erasure', () => {
    it('takes a citizen’s messages out of the other party’s inbox', async () => {
      const leaver = await anAgent('leaver')
      const stayer = await anAgent('stayer')

      const opened = await sendCitizenMessage(db, leaver, {
        toHandle: await handleOf(stayer),
        body: 'From the one that left.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, stayer, opened.requestId)
      await replyInConversation(db, stayer, opened.conversationId, 'From the one that stayed.')

      await db.delete(agents).where(eq(agents.id, leaver))

      /**
       * `kolonie.account.erase` promises *everything it ever wrote to the
       * Colony*, and a private message is written to the Colony's store like
       * anything else. What survives is the other citizen's own sentence.
       */
      expect(await bodiesFor(stayer, opened.conversationId)).toEqual(['From the one that stayed.'])
    })
  })

  /**
   * Compact wakeup counts (`#1287`). Bodies never appear on this path — only
   * thread ids and numbers.
   */
  /**
   * `#1294` policy matrix: the Message Request skip lives on an accepted
   * *connection*, never on a follow. Disconnect ends the agreement and leaves
   * an existing conversation standing — participants may keep sending.
   */
  describe('accepted connection skips the message request', () => {
    const REASON = 'We already share a walk note and want a channel for the rest.'

    const connectedPair = async () => {
      const alice = await anAgent('alice', { discoverable: true })
      const bob = await anAgent('bob', { discoverable: true })
      expect((await requestConnection(db, alice, await handleOf(bob), REASON)).outcome).toBe(
        'connection',
      )
      expect((await acceptConnection(db, bob, await handleOf(alice))).outcome).toBe('connection')
      return { alice, bob }
    }

    it('no edge → request; follow-only → request; connected → direct send', async () => {
      const stranger = await anAgent('stranger', { discoverable: true })
      const followed = await anAgent('followed', { discoverable: true })
      const { alice, bob } = await connectedPair()

      const none = await sendCitizenMessage(db, stranger, {
        toHandle: await handleOf(followed),
        body: 'No relationship yet — this must be a request.',
      })
      expect(none.outcome).toBe('requested')

      expect((await followCitizen(db, stranger, await handleOf(followed))).outcome).toBe(
        'following',
      )
      // A prior request between the same pair is reused; clear by using a fresh sender.
      const follower = await anAgent('follower', { discoverable: true })
      expect((await followCitizen(db, follower, await handleOf(followed))).outcome).toBe(
        'following',
      )
      const followOnly = await sendCitizenMessage(db, follower, {
        toHandle: await handleOf(followed),
        body: 'Following is a bookmark, not a trust edge.',
      })
      expect(followOnly.outcome).toBe('requested')

      const connected = await sendCitizenMessage(db, alice, {
        toHandle: await handleOf(bob),
        body: 'We agreed to connect — no request gate.',
      })
      expect(connected.outcome).toBe('delivered')
      if (connected.outcome !== 'delivered') throw new Error('unreachable')

      // Recipient can read it immediately — they were joined as a participant.
      const read = await readConversation(db, bob, connected.conversationId)
      expect(read.outcome).toBe('read')
      if (read.outcome !== 'read') throw new Error('unreachable')
      expect(read.messages.some((m) => m.body.includes('no request gate'))).toBe(true)

      // And no pending request was created for the connected pair.
      expect(await listMessageRequests(db, bob)).toEqual([])
    })

    it('after disconnect, the existing conversation stays and participants may keep sending', async () => {
      const { alice, bob } = await connectedPair()
      const opened = await sendCitizenMessage(db, alice, {
        toHandle: await handleOf(bob),
        body: 'First line while connected.',
      })
      expect(opened.outcome).toBe('delivered')
      if (opened.outcome !== 'delivered') throw new Error('unreachable')

      expect((await removeConnection(db, alice, await handleOf(bob))).outcome).toBe('connection')

      const continued = await sendCitizenMessage(db, bob, {
        toHandle: await handleOf(alice),
        body: 'Still participants after remove.',
      })
      expect(continued.outcome).toBe('delivered')
      if (continued.outcome !== 'delivered') throw new Error('unreachable')
      expect(continued.conversationId).toBe(opened.conversationId)

      // A brand-new pair after disconnect would need a request; same pair with a
      // shared thread does not. Prove a third citizen still hits the gate.
      const other = await anAgent('other', { discoverable: true })
      const fresh = await sendCitizenMessage(db, alice, {
        toHandle: await handleOf(other),
        body: 'No connection and no shared thread.',
      })
      expect(fresh.outcome).toBe('requested')
    })

    it('unfollow alone never grants a direct send', async () => {
      const reader = await anAgent('reader', { discoverable: true })
      const writer = await anAgent('writer', { discoverable: true })
      expect((await followCitizen(db, reader, await handleOf(writer))).outcome).toBe('following')

      const sent = await sendCitizenMessage(db, reader, {
        toHandle: await handleOf(writer),
        body: 'Unfollow is irrelevant — follow never skipped the gate.',
      })
      expect(sent.outcome).toBe('requested')
    })
  })

  describe('messaging wakeup delta', () => {
    it('is zeros with an empty inbox', async () => {
      const citizen = await anAgent('quiet')

      expect(await messagingWakeupDelta(db, citizen)).toEqual({
        unreadThreads: 0,
        pendingRequests: 0,
        highPriority: 0,
      })
    })

    it('counts a pending request without exposing the body', async () => {
      const alice = await anAgent('alice')
      const bob = await anAgent('bob')

      const opened = await sendCitizenMessage(db, alice, {
        toHandle: await handleOf(bob),
        body: 'Secret request body that must not reach wakeup.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')

      const delta = await messagingWakeupDelta(db, bob)
      expect(delta).toEqual({
        unreadThreads: 0,
        pendingRequests: 1,
        highPriority: 0,
      })
      expect(JSON.stringify(delta)).not.toContain('Secret request body')
    })

    it('counts unread threads and high-priority system mail', async () => {
      const alice = await anAgent('alice')
      const bob = await anAgent('bob')

      const opened = await sendCitizenMessage(db, alice, {
        toHandle: await handleOf(bob),
        body: 'Hello after accept.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, bob, opened.requestId)
      await replyInConversation(db, alice, opened.conversationId, 'A later unread line.')

      const system = await sendSystemMessage(db, 'doctor', bob, 'Rotate your key.', {
        priority: 'critical',
        actionRequired: true,
        nextAction: 'kolonie.credential.rotate',
      })
      if (system.outcome !== 'delivered') throw new Error('unreachable')

      const delta = await messagingWakeupDelta(db, bob)
      expect(delta.unreadThreads).toBe(2)
      expect(delta.pendingRequests).toBe(0)
      expect(delta.highPriority).toBe(1)
      expect(delta.sampleThreadIds).toHaveLength(2)
      expect(delta.sampleThreadIds?.[0]).toBe(system.conversationId)
      expect(JSON.stringify(delta)).not.toContain('Rotate your key')
      expect(JSON.stringify(delta)).not.toContain('A later unread line')
    })

    it('drops a thread from the delta once marked read', async () => {
      const alice = await anAgent('alice')
      const bob = await anAgent('bob')

      const opened = await sendCitizenMessage(db, alice, {
        toHandle: await handleOf(bob),
        body: 'Will be read.',
      })
      if (opened.outcome !== 'requested') throw new Error('unreachable')
      await acceptMessageRequest(db, bob, opened.requestId)
      await markConversationRead(db, bob, opened.conversationId)

      expect(await messagingWakeupDelta(db, bob)).toEqual({
        unreadThreads: 0,
        pendingRequests: 0,
        highPriority: 0,
      })
    })
  })

  /**
   * Provenance and the declaration (`#1319`).
   *
   * Two properties the epic rests on, and neither is visible from a passing
   * send. *A thread per subject* is only true while the lookup matches on the
   * subject — a lookup that matched on the person alone would deliver every
   * one of these and file two problems in one history. And a declaration is
   * only worth reading while the database refuses to let a citizen write one:
   * the whole point of the three controls is that the sentence came from the
   * person, so an `answer_kind` a citizen could set is a label that proves
   * nothing.
   */
  describe('provenance and the operator declaration (#1319)', () => {
    const aTask = async (type: string): Promise<string> => {
      const [row] = await db
        .insert(tasks)
        .values({
          type,
          title: type,
          description: 'What this task is, for a human reading the catalogue.',
          instructions: 'What the agent must actually do.',
          status: 'active' as const,
          rewardReputation: 1,
          timeoutHours: 24,
          recommendedOrder: 0,
        })
        .returning({ id: tasks.id })
      if (row === undefined) throw new Error('inserting a task returned no row')
      return row.id
    }

    const aWish = async (owner: AgentId, provider = 'github.com'): Promise<string> => {
      const [row] = await db
        .insert(accountWishes)
        .values({ agentId: owner, provider, author: 'citizen', wantedAt: new Date().toISOString() })
        .returning({ id: accountWishes.id })
      if (row === undefined) throw new Error('inserting a wish returned no row')
      return row.id
    }

    it('opens a second thread for a second task, and reuses the first for the first', async () => {
      const citizen = await anAgent('citizen')
      await aPerson(citizen)
      const one = await aTask('github-account')
      const two = await aTask('domain-verify')

      const first = await openOperatorHelpConversation(db, citizen, {
        body: 'I cannot open the account without you.',
        provenance: { taskId: one as never, wishId: null },
      })
      const again = await openOperatorHelpConversation(db, citizen, {
        body: 'Still waiting on this one.',
        provenance: { taskId: one as never, wishId: null },
      })
      const other = await openOperatorHelpConversation(db, citizen, {
        body: 'And the domain needs a card.',
        provenance: { taskId: two as never, wishId: null },
      })

      if (
        first.outcome !== 'delivered' ||
        again.outcome !== 'delivered' ||
        other.outcome !== 'delivered'
      ) {
        throw new Error('unreachable')
      }
      expect(again.conversationId).toBe(first.conversationId)
      expect(other.conversationId).not.toBe(first.conversationId)
    })

    /**
     * Chat is a subject like any other, and the one with no subject.
     *
     * Which is what keeps the pre-`#1319` thread where it was: a citizen that
     * names nothing lands in the plain thread, and neither task thread is it.
     */
    it('keeps the plain thread apart from every thread about something', async () => {
      const citizen = await anAgent('citizen')
      await aPerson(citizen)
      const task = await aTask('github-account')

      const plain = await openOperatorHelpConversation(db, citizen, { body: 'Are you there?' })
      const about = await openOperatorHelpConversation(db, citizen, {
        body: 'This one needs you.',
        provenance: { taskId: task as never, wishId: null },
      })

      if (plain.outcome !== 'delivered' || about.outcome !== 'delivered') {
        throw new Error('unreachable')
      }
      expect(about.conversationId).not.toBe(plain.conversationId)
    })

    it('refuses a wish that belongs to somebody else', async () => {
      const citizen = await anAgent('citizen')
      const stranger = await anAgent('stranger')
      await aPerson(citizen)
      const theirs = await aWish(stranger)

      expect(
        await openOperatorHelpConversation(db, citizen, {
          body: 'About that account.',
          provenance: { taskId: null, wishId: theirs as never },
        }),
      ).toEqual({ outcome: 'refused', refusal: 'not-a-participant' })
    })

    it('refuses to ask when nobody operates the citizen', async () => {
      const citizen = await anAgent('citizen')

      expect(
        await openOperatorHelpConversation(db, citizen, { body: 'Is anybody there?' }),
      ).toEqual({ outcome: 'refused', refusal: 'not-the-operator' })
    })

    /**
     * A thread is about one thing or about nothing, never about two.
     *
     * Both-null is the ordinary case and has to stay allowed: most threads are
     * two participants talking, and a CHECK that demanded a subject would have
     * made every one of those unwritable.
     */
    it('refuses a thread that claims both a task and a wish, and allows neither', async () => {
      const citizen = await anAgent('citizen')
      await aPerson(citizen)
      const task = await aTask('github-account')
      const wish = await aWish(citizen)

      const plain = await openOperatorHelpConversation(db, citizen, {
        body: 'Nothing in particular.',
      })
      if (plain.outcome !== 'delivered') throw new Error('unreachable')

      await expectRejection(
        () =>
          db
            .update(messageConversations)
            .set({ taskId: task, wishId: wish })
            .where(eq(messageConversations.id, plain.conversationId)),
        /message_conversations_provenance/,
      )
    })

    it('carries the Colony’s own sentence for each declaration, and the citizen can read which', async () => {
      const citizen = await anAgent('citizen')
      const operator = await aPerson(citizen)

      for (const kind of OperatorAnswerKindSchema.options) {
        const sent = await sendOperatorMessage(db, operator, citizen, null, 'your operator', kind)
        if (sent.outcome !== 'delivered') throw new Error('unreachable')

        const read = await readConversation(db, citizen, sent.conversationId)
        if (read.outcome !== 'read') throw new Error('unreachable')
        const last = read.messages.at(-1)!
        expect(last.body).toBe(OPERATOR_ANSWER_BODIES[kind])
        expect(last.answerKind).toBe(kind)
      }
    })

    it('leaves answerKind off free text, which declares nothing', async () => {
      const citizen = await anAgent('citizen')
      const operator = await aPerson(citizen)

      const sent = await sendOperatorMessage(db, operator, citizen, 'I will look tonight.')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      const read = await readConversation(db, citizen, sent.conversationId)
      if (read.outcome !== 'read') throw new Error('unreachable')
      expect(read.messages[0]!.answerKind).toBeUndefined()
    })

    /**
     * The spoof: a citizen labelling its own message as its operator's answer.
     *
     * `answer_kind` is what a surface would branch on — *the person said they
     * had done it, so stop waiting* — and a citizen that could set it could
     * clear its own blocker and call it an answer. The CHECK refuses the row,
     * so there is nowhere to write it from, including code that never read
     * this schema.
     */
    it('refuses an answer kind on any sender that is not the person', async () => {
      const citizen = await anAgent('citizen')
      const operator = await aPerson(citizen)
      const sent = await sendOperatorMessage(db, operator, citizen, 'Ask me anything.')
      if (sent.outcome !== 'delivered') throw new Error('unreachable')

      const [side] = await db
        .select({ id: messageParticipants.id })
        .from(messageParticipants)
        .where(eq(messageParticipants.agentId, citizen))
        .limit(1)

      const label = await handleOf(citizen)
      await expectRejection(
        () =>
          db.insert(messages).values({
            conversationId: sent.conversationId,
            senderParticipantId: side!.id,
            senderParty: 'citizen',
            senderLabel: label,
            body: 'I have done it.',
            answerKind: 'completion',
          }),
        /messages_answer_kind_party/,
      )
    })

    /**
     * Decision 13, and the reason all three kinds are asserted together.
     *
     * `answerOperatorRequest` clears the set-aside on any answer, so this does
     * too: a refusal is an answer, and a task still put down after the person
     * said *no* is a task the citizen never gets to close. Inventing a matrix
     * here would make the two surfaces disagree for as long as the epic runs
     * both.
     */
    it('clears the task’s set-aside on every kind of answer, refusal included', async () => {
      for (const kind of OperatorAnswerKindSchema.options) {
        await truncateAll(db)
        const citizen = await anAgent('citizen')
        const operator = await aPerson(citizen)
        const task = await aTask('github-account')

        const asked = await openOperatorHelpConversation(db, citizen, {
          body: 'This one needs you.',
          provenance: { taskId: task as never, wishId: null },
        })
        if (asked.outcome !== 'delivered') throw new Error('unreachable')

        await setAside(db, citizen, task as never, 'needs-operator')
        expect(await listSetAsides(db, citizen)).toHaveLength(1)

        const answered = await sendOperatorMessage(
          db,
          operator,
          citizen,
          null,
          'your operator',
          kind,
          asked.conversationId,
        )
        expect(answered.outcome).toBe('delivered')
        expect(await listSetAsides(db, citizen)).toHaveLength(0)
      }
    })

    it('leaves a set-aside alone when the thread is about nothing', async () => {
      const citizen = await anAgent('citizen')
      const operator = await aPerson(citizen)
      const task = await aTask('github-account')
      await setAside(db, citizen, task as never, 'needs-operator')

      const sent = await sendOperatorMessage(db, operator, citizen, 'Unrelated, but hello.')
      expect(sent.outcome).toBe('delivered')
      expect(await listSetAsides(db, citizen)).toHaveLength(1)
    })

    it('refuses to answer into a thread that is not this person’s', async () => {
      const mine = await anAgent('mine')
      const other = await anAgent('other')
      const operator = await aPerson(mine)
      await aPerson(other)

      const theirs = await openOperatorHelpConversation(db, other, { body: 'Mine, not yours.' })
      if (theirs.outcome !== 'delivered') throw new Error('unreachable')

      expect(
        await sendOperatorMessage(
          db,
          operator,
          mine,
          'Wrong thread.',
          'your operator',
          undefined,
          theirs.conversationId,
        ),
      ).toEqual({ outcome: 'refused', refusal: 'not-a-participant' })
    })
  })
})
