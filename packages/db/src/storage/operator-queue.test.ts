import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId, HumanId, TaskId, WishId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agents,
  accountWishes,
  browserShares,
  humanAgents,
  humans,
  operatorRequests,
  operatorRequestMessages,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { seedAcademyTasks } from '../academy-tasks/index.js'
import { taskIdForType } from './challenge-tasks.js'
import { openDrop } from './operator-drops.js'
import { waitingForOperator } from './operator-queue.js'

const target = databaseTestTarget()

/**
 * One queue across every agent a person operates (#530).
 *
 * **What this file is really checking is the *waiting* rule**, which is the only
 * part a fake could get wrong without anybody noticing: an exchange the operator
 * has already replied to is still open and is not waiting on them, and a drop
 * that has been filled, has expired or has run out of attempts is not either.
 * Everything else about the page is layout.
 */
describe('the operator queue', () => {
  let db: Database
  let humanId: HumanId
  /**
   * Any real task, because `operator_requests.task_id` is not nullable — `#236`
   * requires a request to belong to a task and never to float.
   */
  let taskId: TaskId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string, operatedBy?: HumanId): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')

    if (operatedBy !== undefined) {
      await db.insert(humanAgents).values({ humanId: operatedBy, agentId: row.id })
    }

    return row.id as AgentId
  }

  const aPerson = async (): Promise<HumanId> => {
    const [row] = await db.insert(humans).values({}).returning({ id: humans.id })
    if (row === undefined) throw new Error('inserting a human returned no row')
    return row.id as HumanId
  }

  /** An exchange with one message from the agent and no reply. */
  const aQuestion = async (agentId: AgentId, ask: string): Promise<void> => {
    const [request] = await db
      .insert(operatorRequests)
      .values({ agentId, taskId })
      .returning({ id: operatorRequests.id })
    if (request === undefined) throw new Error('inserting a request returned no row')

    await db
      .insert(operatorRequestMessages)
      .values({ requestId: request.id, author: 'citizen', body: ask })
  }

  const aWishQuestion = async (
    agentId: AgentId,
    provider: string,
    ask: string,
  ): Promise<WishId> => {
    const [wish] = await db
      .insert(accountWishes)
      .values({ agentId, provider, author: 'citizen', wantedAt: new Date().toISOString() })
      .returning({ id: accountWishes.id })
    if (wish === undefined) throw new Error('inserting a wish returned no row')
    const [request] = await db
      .insert(operatorRequests)
      .values({ agentId, wishId: wish.id })
      .returning({ id: operatorRequests.id })
    if (request === undefined) throw new Error('inserting a request returned no row')
    await db
      .insert(operatorRequestMessages)
      .values({ requestId: request.id, author: 'citizen', body: ask })
    return wish.id as WishId
  }

  /**
   * An open, unaccepted offer of a live tab — history rather than a channel
   * (`#738`, withdrawn by `#912`).
   *
   * Nothing writes one of these any more, and the table outlives the feature by
   * one issue (`#914`). It is inserted here so that the one thing left to check
   * can be checked: that a person whose account carries such a row still gets
   * their queue, with nothing in it about a tab.
   */
  const aShare = async (
    agentId: AgentId,
    purpose: string,
    where: { readonly provider?: string; readonly step?: number } = {},
    minutesLeft = 90,
  ): Promise<string> => {
    const [row] = await db
      .insert(browserShares)
      .values({
        agentId,
        tokenHash: 'not-a-token, and never presented to anything in this file',
        targetId: 'page-1',
        purpose,
        provider: where.provider ?? null,
        step: where.step ?? null,
        expiresAt: new Date(Date.now() + minutesLeft * 60_000).toISOString(),
      })
      .returning({ id: browserShares.id })
    if (row === undefined) throw new Error('inserting a share returned no row')
    return row.id
  }

  beforeEach(async () => {
    await truncateAll(db)
    await seedAcademyTasks(db)
    const seeded = await taskIdForType(db, 'web-server-verify')
    if (seeded === null) throw new Error('the seed produced no web-server rung')
    taskId = seeded
    humanId = await aPerson()
  })

  it('gathers every agent’s waiting items into one list', async () => {
    const first = await anAgent('one', humanId)
    const second = await anAgent('two', humanId)

    await aQuestion(first, 'May I run a public web server on this machine?')
    await openDrop(db, {
      agentId: second,
      kind: 'code',
      prompt: 'The six digits from the text.',
      taskId,
    })

    const queue = await waitingForOperator(db, humanId)

    expect(queue.map((row) => row.agentName)).toEqual(['two', 'one'])
    expect(queue.map((row) => row.kind)).toEqual(['code', 'question'])
  })

  it('uses the wanted provider as the context for a wish request', async () => {
    const agentId = await anAgent('one', humanId)
    await aWishQuestion(agentId, 'github.com', 'Please create the account.')

    const [item] = await waitingForOperator(db, humanId)
    expect(item?.about).toBe('github.com')
  })

  it('orders by what each one costs to clear rather than by age', async () => {
    const agentId = await anAgent('one', humanId)

    // The question is opened first and is therefore the oldest. It still comes
    // last, which is the ordering the issue asks for.
    await aQuestion(agentId, 'Which of these two providers should I use?')
    await openDrop(db, { agentId, kind: 'credential', prompt: 'The API key.', vaultKey: 'k' })
    await openDrop(db, { agentId, kind: 'code', prompt: 'The code from your handset.', taskId })

    const queue = await waitingForOperator(db, humanId)

    expect(queue.map((row) => row.kind)).toEqual(['code', 'credential', 'question'])
  })

  /**
   * The rejection case for `#912`: an account with share history.
   *
   * The row here is exactly what the query used to select — open, unaccepted,
   * hours of validity left — and the queue is now blind to it. Two things are
   * being asserted at once: that no third arm survives, and that a person whose
   * account carries one of these rows still gets a queue rather than an error,
   * which is what stops this from depending on `#914` dropping the table.
   */
  it('says nothing about a tab an agent once offered, and still answers', async () => {
    const agentId = await anAgent('one', humanId)
    await aShare(agentId, 'A picture puzzle I cannot read.', { provider: 'mail.tm', step: 3 })

    expect(await waitingForOperator(db, humanId)).toEqual([])

    await aQuestion(agentId, 'May I open an account at this provider?')
    const queue = await waitingForOperator(db, humanId)

    expect(queue.map((row) => row.kind)).toEqual(['question'])
    expect(JSON.stringify(queue)).not.toContain('picture puzzle')
  })

  it('drops an exchange the operator has already replied to', async () => {
    const agentId = await anAgent('one', humanId)

    const [request] = await db
      .insert(operatorRequests)
      .values({ agentId, taskId })
      .returning({ id: operatorRequests.id })
    if (request === undefined) throw new Error('inserting a request returned no row')

    await db
      .insert(operatorRequestMessages)
      .values({ requestId: request.id, author: 'citizen', body: 'May I?' })

    expect(await waitingForOperator(db, humanId)).toHaveLength(1)

    await db
      .insert(operatorRequestMessages)
      .values({ requestId: request.id, author: 'operator', body: 'Yes.' })

    // Still open — the citizen may not have read it yet — and no longer waiting
    // on the person. A queue that showed answered exchanges never empties.
    expect(await waitingForOperator(db, humanId)).toHaveLength(0)
  })

  it('shows the first message and not the latest', async () => {
    const agentId = await anAgent('one', humanId)

    const [request] = await db
      .insert(operatorRequests)
      .values({ agentId, taskId })
      .returning({ id: operatorRequests.id })
    if (request === undefined) throw new Error('inserting a request returned no row')

    // Two statements rather than one, so the two rows genuinely differ in
    // `written_at` — inserted together they would share a transaction timestamp
    // and *first* would stop meaning anything.
    await db.insert(operatorRequestMessages).values({
      requestId: request.id,
      author: 'citizen',
      body: 'May I open an account at this provider?',
    })
    await db
      .insert(operatorRequestMessages)
      .values({ requestId: request.id, author: 'citizen', body: 'Still waiting, no hurry.' })

    const [item] = await waitingForOperator(db, humanId)
    expect(item?.ask).toBe('May I open an account at this provider?')
  })

  it('shows nothing belonging to somebody else’s agent', async () => {
    const stranger = await aPerson()
    const theirs = await anAgent('theirs', stranger)
    await aQuestion(theirs, 'May I?')

    expect(await waitingForOperator(db, humanId)).toHaveLength(0)
    expect(await waitingForOperator(db, stranger)).toHaveLength(1)
  })

  it('gives an operator with nothing waiting an empty list rather than a failure', async () => {
    await anAgent('idle', humanId)

    expect(await waitingForOperator(db, humanId)).toEqual([])
  })
})
