import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, HumanIdSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accounts,
  agents,
  humanAgents,
  humans,
  messageParticipants,
  operatorPages,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { openOperatorHelpConversation, sendColonyMessageToOperatorThread } from './messaging.js'
import { operatorThreadsForPageToken } from './operator-threads.js'

const target = databaseTestTarget()

/**
 * The Colony's own sentence, in the citizen's operator thread (`#1445`).
 *
 * **The property under test is one a person has to be able to see.**
 * `packages/core/src/operator/handover.ts` constraint 4 says an agent must not
 * be able to compose the message arriving beside its secret — that is a
 * prompt-injection boundary rather than ceremony, and a person acting on a
 * handoff is relying on it. `#1437` decision 2 relaxes it for a *share*, which
 * hangs on a thread the citizen is visibly writing in, and deliberately does not
 * reach a handoff, which arrives cold.
 */
describe('a handoff, as a Colony message on a linked thread', () => {
  let db: Database
  let agentId: AgentId
  let humanId: HumanId
  let accountId: string
  let pageToken: string
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db.$client.end()
  })

  beforeEach(async () => {
    await truncateAll(db)
    pageToken = `page-${++seeded}`

    const [agent] = await db
      .insert(agents)
      .values({ name: `keeper-${seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    agentId = AgentIdSchema.parse(agent!.id)

    const [person] = await db.insert(humans).values({}).returning({ id: humans.id })
    humanId = HumanIdSchema.parse(person!.id)
    await db.insert(humanAgents).values({ agentId, humanId })
    await db
      .insert(operatorPages)
      .values({ agentId, operatorAddress: `op-${seeded}@example.test`, token: pageToken })

    const [account] = await db
      .insert(accounts)
      .values({ agentId, kind: 'github', identifier: 'octocat', provider: 'github.com' })
      .returning({ id: accounts.id })
    accountId = account!.id
  })

  it('opens an account-linked thread the operator is in', async () => {
    const sent = await sendColonyMessageToOperatorThread(
      db,
      agentId,
      { accountId },
      'Please open a GitHub account and confirm the address.',
    )
    if (sent.outcome !== 'delivered') throw new Error(sent.outcome)

    const [thread] = await operatorThreadsForPageToken(db, pageToken)

    expect(thread?.threadId).toBe(sent.conversationId)
    expect(thread?.accountIdentifier).toBe('octocat')
  })

  it('attributes it to the Colony, visibly apart from the citizen', async () => {
    const sent = await sendColonyMessageToOperatorThread(
      db,
      agentId,
      { accountId },
      'Please open a GitHub account and confirm the address.',
    )
    if (sent.outcome !== 'delivered') throw new Error(sent.outcome)

    const [thread] = await operatorThreadsForPageToken(db, pageToken)

    // Three authors, not two. Folding this into the citizen's column would make
    // *no agent wrote this* a promise instead of something a reader can check.
    expect(thread?.messages).toHaveLength(1)
    expect(thread?.messages[0]?.author).toBe('colony')
  })

  it('lets the citizen write freely in the same thread, as itself', async () => {
    const sent = await sendColonyMessageToOperatorThread(
      db,
      agentId,
      { accountId },
      'Please open a GitHub account and confirm the address.',
    )
    if (sent.outcome !== 'delivered') throw new Error(sent.outcome)

    const mine = await openOperatorHelpConversation(db, agentId, {
      body: 'I will take the account over as soon as it exists.',
      provenance: { accountId },
    })
    if (mine.outcome !== 'delivered') throw new Error(mine.outcome)

    // Same thread — the subject matched — and the two are told apart.
    expect(mine.conversationId).toBe(sent.conversationId)

    const [thread] = await operatorThreadsForPageToken(db, pageToken)
    expect(thread?.messages.map((message) => message.author)).toEqual(['colony', 'citizen'])
  })

  it('reuses the thread on a second handoff about the same account', async () => {
    const first = await sendColonyMessageToOperatorThread(db, agentId, { accountId }, 'Step one.')
    const again = await sendColonyMessageToOperatorThread(db, agentId, { accountId }, 'Step two.')

    if (first.outcome !== 'delivered' || again.outcome !== 'delivered') throw new Error('refused')
    expect(again.conversationId).toBe(first.conversationId)

    // One Colony participant, not one per message.
    const colony = await db
      .select({ id: messageParticipants.id })
      .from(messageParticipants)
      .where(eq(messageParticipants.conversationId, first.conversationId))

    expect(colony).toHaveLength(3)
  })

  it('refuses a citizen with nobody linked', async () => {
    const [alone] = await db
      .insert(agents)
      .values({ name: `alone-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })

    expect(
      await sendColonyMessageToOperatorThread(
        db,
        AgentIdSchema.parse(alone!.id),
        {},
        'Nobody to tell.',
      ),
    ).toMatchObject({ outcome: 'refused', refusal: 'not-the-operator' })
  })
})
