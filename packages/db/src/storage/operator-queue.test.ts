import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId, HumanId, TaskId, WishId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, accountWishes, humanAgents, humans } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { seedAcademyTasks } from '../academy-tasks/index.js'
import { taskIdForType } from './challenge-tasks.js'
import { openDrop } from './operator-drops.js'
import { waitingForOperator } from './operator-queue.js'
import { openOperatorHelpConversation, sendOperatorMessage } from './messaging.js'

const target = databaseTestTarget()

/**
 * One queue across every agent a person operates (#530).
 *
 * **What this file is really checking is the *waiting* rule**, which is the only
 * part a fake could get wrong without anybody noticing: a thread the operator
 * has already replied to is not waiting on them, and a drop that has been
 * filled, has expired or has run out of attempts is not either. Everything else
 * about the page is layout.
 */
describe('the operator queue', () => {
  let db: Database
  let humanId: HumanId
  /**
   * Any real task. A conversation may name none — `#1319` deliberately permits a
   * thread about nothing in particular — but the queue's own `about` column
   * reads the title, so the cases here give it one.
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

  /** A thread with one message from the agent and no reply. */
  const aQuestion = async (agentId: AgentId, ask: string): Promise<string> => {
    const opened = await openOperatorHelpConversation(db, agentId, {
      body: ask,
      provenance: { taskId },
    })
    if (opened.outcome !== 'delivered') throw new Error(`open refused: ${opened.outcome}`)
    return opened.conversationId
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

    const opened = await openOperatorHelpConversation(db, agentId, {
      body: ask,
      provenance: { wishId: wish.id as WishId },
    })
    if (opened.outcome !== 'delivered') throw new Error(`open refused: ${opened.outcome}`)

    return wish.id as WishId
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
   * `#912` left a case here that inserted a real `browser_shares` row and
   * asserted the queue was blind to it — the point being that an account with
   * share history did not need the table dropped in order to render. `#914`
   * dropped it, so the row cannot be written and the case retires with the
   * fixture it was built on. What it was guarding is now structural: there is no
   * third arm to select, and no table for one to select from.
   */

  it('drops a thread the operator has already replied to', async () => {
    const agentId = await anAgent('one', humanId)
    await aQuestion(agentId, 'May I?')

    expect(await waitingForOperator(db, humanId)).toHaveLength(1)

    const answered = await sendOperatorMessage(db, humanId, agentId, 'Yes.')
    expect(answered.outcome).toBe('delivered')

    // The citizen may not have read it yet, and it is no longer waiting on the
    // person. A queue that showed answered threads never empties.
    expect(await waitingForOperator(db, humanId)).toHaveLength(0)
  })

  it('shows the first message and not the latest', async () => {
    const agentId = await anAgent('one', humanId)

    // Two calls rather than one, so the two rows genuinely differ in
    // `created_at` — written together they would share a transaction timestamp
    // and *first* would stop meaning anything. The second lands in the same
    // thread because the provenance matches (`#1319`).
    await aQuestion(agentId, 'May I open an account at this provider?')
    await aQuestion(agentId, 'Still waiting, no hurry.')

    const waiting = await waitingForOperator(db, humanId)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.ask).toBe('May I open an account at this provider?')
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
