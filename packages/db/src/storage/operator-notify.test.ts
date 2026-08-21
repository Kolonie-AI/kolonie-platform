import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentIdSchema, HumanIdSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import { sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { agents, humanAgents, humans, messageParticipants } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  archiveConversationForOperator,
  claimOperatorNotification,
  markConversationReadByOperator,
  openOperatorHelpConversation,
  sendOperatorMessage,
} from './messaging.js'

const target = databaseTestTarget()

/**
 * When a person is told that something arrived (`#1451`, epic `#1447`).
 *
 * ## The rule this replaces, and why it had to go
 *
 * `#1321` carried `operator_addresses`' rule across: **one ping per thread, and
 * never on a reply**. It protects against a real thing — an agent costing a
 * person five mails in an afternoon — and it did so by never telling them
 * anything after the first message. Measured in production on 2026-08-20:
 * **sixteen threads had an agent message newer than the operator's last reply
 * and nobody had been told about any of them.**
 *
 * The four cases in `#1447` frozen decision 1 are the first four tests here, in
 * the order the issue tables them. Three are unchanged and one is the fix.
 */
describe('telling a person something arrived', () => {
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

  /** A message from the agent, and whether the Colony would tell the person. */
  const agentWrites = async (body: string): Promise<boolean> => {
    const sent = await openOperatorHelpConversation(db, agentId, { body })
    if (sent.outcome !== 'delivered') throw new Error(sent.outcome)
    return (await claimOperatorNotification(db, sent.conversationId, sent.messageId)) !== undefined
  }

  /** Move the last-notified stamp back, standing in for a day passing. */
  const aDayPasses = async () => {
    await db
      .update(messageParticipants)
      .set({ notifiedAt: sql`now() - interval '25 hours'` })
      .where(sql`${messageParticipants.humanId} = ${humanId}::uuid`)
  }

  it('tells them four times about a thread opened this morning: once', async () => {
    // Unchanged from the old rule, and the case it existed for.
    expect(await agentWrites('One.')).toBe(true)
    expect(await agentWrites('Two.')).toBe(false)
    expect(await agentWrites('Three.')).toBe(false)
    expect(await agentWrites('Four.')).toBe(false)
  })

  it('tells them about a reply to a thread they answered last week', async () => {
    /**
     * **The 16-thread defect, in one test.** Under *never on a reply* this was
     * silent for ever: the person answered, the agent came back, and nothing
     * reached anybody.
     */
    expect(await agentWrites('May I?')).toBe(true)

    const [row] = await db
      .select({ id: messageParticipants.conversationId })
      .from(messageParticipants)
      .where(sql`${messageParticipants.humanId} = ${humanId}::uuid`)
    const thread = row!.id as Parameters<typeof markConversationReadByOperator>[2]

    await markConversationReadByOperator(db, humanId, thread)
    await sendOperatorMessage(db, humanId, agentId, 'Yes, go ahead.', undefined, undefined, thread)
    await aDayPasses()

    expect(await agentWrites('It did not work. May I try the other one?')).toBe(true)
  })

  it('tells them once about a thread nudged hourly for a day', async () => {
    expect(await agentWrites('Are you there?')).toBe(true)
    for (const hour of [1, 2, 3, 4, 5]) {
      expect(await agentWrites(`Nudge ${String(hour)}.`)).toBe(false)
    }
  })

  it('tells them once per thread when ten agents each open one', async () => {
    let told = 0
    for (let n = 0; n < 10; n += 1) {
      const [row] = await db
        .insert(agents)
        .values({ name: `fleet-${++seeded}`, platform: 'openclaw' })
        .returning({ id: agents.id })
      const each = AgentIdSchema.parse(row!.id)
      await db.insert(humanAgents).values({ agentId: each, humanId })

      const sent = await openOperatorHelpConversation(db, each, { body: 'A question.' })
      if (sent.outcome !== 'delivered') throw new Error(sent.outcome)
      if (
        (await claimOperatorNotification(db, sent.conversationId, sent.messageId)) !== undefined
      ) {
        told += 1
      }
    }

    // Ten threads, ten mails — unchanged, and correct: the quiet period is per
    // thread because ten different things needing an answer are ten asks.
    expect(told).toBe(10)
  })

  it('says nothing about a message the person has already read', async () => {
    const sent = await openOperatorHelpConversation(db, agentId, { body: 'One.' })
    if (sent.outcome !== 'delivered') throw new Error(sent.outcome)
    expect(await claimOperatorNotification(db, sent.conversationId, sent.messageId)).toBeDefined()

    await markConversationReadByOperator(db, humanId, sent.conversationId)
    await aDayPasses()

    /**
     * **What condition 2 actually guards.** A day has passed and the message is
     * from the agent, so neither the quiet period nor the sender is what stops
     * this — the cursor is. A retry, a replay, or a second pass over a delivery
     * that already went out cannot mail somebody about words they have read.
     *
     * Note what this does **not** say: a *new* message into a thread they read
     * last week does notify, and that is the whole point of the issue. Unread
     * is a fact about this message against the cursor, not about the thread
     * having ever been opened.
     */
    expect(await claimOperatorNotification(db, sent.conversationId, sent.messageId)).toBeUndefined()
  })

  /**
   * **There was a fourth condition and it was mute** (`#1549`). *Not muted,
   * whatever the other three say* — and it was never once true: 0 of 107
   * participants had ever muted anything, measured 2026-08-21. The two tests
   * that stood here asserted it and are gone with it.
   *
   * The cap is what answers the case mute was specified for, and it is the
   * condition above: one mail per thread per person per day. Nothing about
   * removing the fourth loosens this path, because an unmuted thread is what
   * every row already was.
   */
  it('never tells a person about their own words', async () => {
    expect(await agentWrites('May I?')).toBe(true)

    const [row] = await db
      .select({ id: messageParticipants.conversationId })
      .from(messageParticipants)
      .where(sql`${messageParticipants.humanId} = ${humanId}::uuid`)
    const thread = row!.id as Parameters<typeof markConversationReadByOperator>[2]

    await aDayPasses()
    const answered = await sendOperatorMessage(
      db,
      humanId,
      agentId,
      'Yes.',
      undefined,
      undefined,
      thread,
    )
    if (answered.outcome !== 'delivered') throw new Error(answered.outcome)

    expect(
      await claimOperatorNotification(db, answered.conversationId, answered.messageId),
    ).toBeUndefined()
  })

  it('spends the quiet period even where a thread is archived', async () => {
    expect(await agentWrites('One.')).toBe(true)

    const [row] = await db
      .select({ id: messageParticipants.conversationId })
      .from(messageParticipants)
      .where(sql`${messageParticipants.humanId} = ${humanId}::uuid`)
    const thread = row!.id as Parameters<typeof archiveConversationForOperator>[2]

    await archiveConversationForOperator(db, humanId, thread, true)
    await aDayPasses()

    /**
     * **Archiving does not buy silence, and it never did.** Archived means *I am
     * done with this*; a new message un-archives it in the same insert that
     * writes it (`#1449`), so the thread is back in the list and telling the
     * person is right. What buys silence is the quiet period above — one mail
     * per thread per day — which is the cap `#1549` found had made mute
     * unnecessary all along.
     */
    expect(await agentWrites('Two.')).toBe(true)
  })

  it('answers nothing for a thread with no person in it', async () => {
    const [other] = await db
      .insert(agents)
      .values({ name: `stranger-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    const strangerId = AgentIdSchema.parse(other!.id)

    // No `human_agents` row, so `openOperatorHelpConversation` has nobody to
    // open against — which is the shape a citizen or Colony thread has, and the
    // reason the claim is safe to run on every delivered send.
    const sent = await openOperatorHelpConversation(db, strangerId, { body: 'Anybody?' })
    if (sent.outcome === 'delivered') {
      expect(
        await claimOperatorNotification(db, sent.conversationId, sent.messageId),
      ).toBeUndefined()
    }
  })

  it('claims once when two messages land together', async () => {
    const first = await openOperatorHelpConversation(db, agentId, { body: 'One.' })
    if (first.outcome !== 'delivered') throw new Error(first.outcome)
    const second = await openOperatorHelpConversation(db, agentId, { body: 'Two.' })
    if (second.outcome !== 'delivered') throw new Error(second.outcome)

    /**
     * **The stamp is written in the statement that decides**, so a read
     * followed by a write cannot both find it stale. Concurrency in a test is
     * awkward to force honestly; what this asserts is the property that makes
     * it safe — two claims against one participant, run together, and exactly
     * one of them wins.
     */
    const [a, b] = await Promise.all([
      claimOperatorNotification(db, first.conversationId, first.messageId),
      claimOperatorNotification(db, second.conversationId, second.messageId),
    ])

    expect([a, b].filter((claim) => claim !== undefined)).toHaveLength(1)
  })
})
