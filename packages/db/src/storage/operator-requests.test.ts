import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AgentId, OperatorRequestId, TaskId, WishId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agents,
  accountWishes,
  autonomyContracts,
  operatorRequestMessages,
  operatorRequests,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { issueOperatorPage, revokeOperatorPage } from './operator-pages.js'
import { listSetAsides, setAside } from './set-asides.js'
import {
  answerOperatorRequest,
  closeOperatorRequest,
  countWaitingOperatorReplies,
  hasOpenOperatorRequest,
  listOperatorRequests,
  exchangesForToken,
  openOperatorRequest,
  operatorRequestRecipient,
  readOperatorRequest,
  replyToOperatorRequest,
} from './operator-requests.js'

const target = databaseTestTarget()
const OPERATOR = 'operator@example.org'
const ASK = 'I cannot create a GitHub account on my own. Could you make one for me?'

describe('the operator request (#236)', () => {
  let db: Database
  let agentId: AgentId
  let taskId: TaskId

  const aWantedWish = async (owner: AgentId, provider = 'github.com'): Promise<WishId> => {
    const [row] = await db
      .insert(accountWishes)
      .values({ agentId: owner, provider, author: 'citizen', wantedAt: new Date().toISOString() })
      .returning({ id: accountWishes.id })
    if (row === undefined) throw new Error('inserting a wish returned no row')
    return row.id as WishId
  }

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

  const aTask = async (type: string): Promise<TaskId> => {
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
    return row.id as TaskId
  }

  const anOpenRequest = async (): Promise<OperatorRequestId> => {
    const opened = await openOperatorRequest(db, { agentId, taskId, body: ASK })
    if (opened.outcome !== 'opened') throw new Error(`expected opened, got ${opened.outcome}`)
    return opened.request.id
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('canary')
    taskId = await aTask('github-account')
  })

  describe('opening one', () => {
    it('carries the ask as its first message, attributed to the citizen', async () => {
      const opened = await openOperatorRequest(db, { agentId, taskId, body: ASK })

      expect(opened.outcome).toBe('opened')
      if (opened.outcome !== 'opened') return

      expect(opened.request.taskId).toBe(taskId)
      expect(opened.request.wishId).toBeNull()
      expect(opened.request.context).toBe('github-account')
      expect(opened.request.closedAt).toBeNull()
      expect(opened.request.answered).toBe(false)
      expect(opened.request.messages).toHaveLength(1)
      expect(opened.request.messages[0]?.author).toBe('citizen')
      expect(opened.request.messages[0]?.body).toBe(ASK)
    })

    /**
     * The amendment of 2026-08-03. Without this the loop `#234` describes has not
     * been fixed — it has acquired a recipient, and the first operator it happens
     * to will stop reading.
     */
    it('allows several open requests up to the configured ceiling', async () => {
      const setting = { read: async () => '2', forget: () => undefined }
      const first = await openOperatorRequest(db, { agentId, taskId, body: ASK }, setting)
      const second = await openOperatorRequest(db, { agentId, taskId, body: ASK }, setting)
      const third = await openOperatorRequest(db, { agentId, taskId, body: ASK }, setting)

      expect(first.outcome).toBe('opened')
      expect(second.outcome).toBe('opened')
      expect(third.outcome).toBe('at-ceiling')
      if (third.outcome !== 'at-ceiling') return
      expect(third.openRequests).toHaveLength(2)
      expect(third.openRequests.every((request) => request.context === 'github-account')).toBe(true)
    })

    it('reads the ceiling at each open attempt rather than once at startup', async () => {
      let value = '2'
      const setting = { read: async () => value, forget: () => undefined }

      expect((await openOperatorRequest(db, { agentId, taskId, body: ASK }, setting)).outcome).toBe(
        'opened',
      )
      value = '1'
      expect((await openOperatorRequest(db, { agentId, taskId, body: ASK }, setting)).outcome).toBe(
        'at-ceiling',
      )
    })

    it('allows the next one once the citizen has closed the first', async () => {
      const first = await anOpenRequest()
      await closeOperatorRequest(db, { agentId, requestId: first })

      const second = await openOperatorRequest(db, { agentId, taskId, body: ASK })
      expect(second.outcome).toBe('opened')
    })

    /**
     * The ceiling is per citizen and not per Colony: one blocked agent must not be
     * able to stop another asking for help.
     */
    it('does not let one citizen’s open request block another citizen’s', async () => {
      await anOpenRequest()
      const sibling = await anAgent('sibling')

      const theirs = await openOperatorRequest(db, { agentId: sibling, taskId, body: ASK })
      expect(theirs.outcome).toBe('opened')
    })

    it('refuses a task that does not exist', async () => {
      const outcome = await openOperatorRequest(db, {
        agentId,
        taskId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' as TaskId,
        body: ASK,
      })
      expect(outcome.outcome).toBe('no-such-task')
    })

    it('is refused by the database when both or neither provenance is set', async () => {
      const wishId = await aWantedWish(agentId)
      await expectRejection(
        () => db.insert(operatorRequests).values({ agentId, taskId, wishId }),
        /operator_requests_exactly_one_provenance/,
      )
      await expectRejection(
        () => db.insert(operatorRequests).values({ agentId }),
        /operator_requests_exactly_one_provenance/,
      )
    })

    it('opens against a wanted wish belonging to the citizen', async () => {
      const wishId = await aWantedWish(agentId)
      const opened = await openOperatorRequest(db, { agentId, wishId, body: ASK })

      expect(opened.outcome).toBe('opened')
      if (opened.outcome !== 'opened') return
      expect(opened.request.taskId).toBeNull()
      expect(opened.request.wishId).toBe(wishId)
      expect(opened.request.context).toBe('github.com')
    })

    it('refuses an unmarked wish or another citizen’s wanted wish', async () => {
      const [unmarked] = await db
        .insert(accountWishes)
        .values({ agentId, provider: 'unmarked.example', author: 'citizen' })
        .returning({ id: accountWishes.id })
      const stranger = await anAgent('stranger')
      const theirs = await aWantedWish(stranger, 'theirs.example')

      expect(
        await openOperatorRequest(db, { agentId, wishId: unmarked!.id as WishId, body: ASK }),
      ).toEqual({ outcome: 'no-such-wish' })
      expect(await openOperatorRequest(db, { agentId, wishId: theirs, body: ASK })).toEqual({
        outcome: 'no-such-wish',
      })
    })
  })

  describe('reading it', () => {
    it('needs both the id and the citizen it belongs to', async () => {
      const requestId = await anOpenRequest()
      const stranger = await anAgent('stranger')

      expect(await readOperatorRequest(db, { requestId, agentId })).toBeDefined()
      // The same answer a request that does not exist gets — no oracle for ids.
      expect(await readOperatorRequest(db, { requestId, agentId: stranger })).toBeUndefined()
    })

    it('lists the citizen’s own exchanges and nobody else’s', async () => {
      const requestId = await anOpenRequest()
      const stranger = await anAgent('stranger')
      await openOperatorRequest(db, { agentId: stranger, taskId, body: ASK })

      const mine = await listOperatorRequests(db, agentId)
      expect(mine.map((request) => request.id)).toEqual([requestId])
    })
  })

  describe('answering it', () => {
    it('appends the operator’s words, attributed to the operator', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)

      const answered = await answerOperatorRequest(db, {
        token,
        requestId,
        body: 'Done — the handle is @canary-ai.',
      })
      expect(answered.outcome).toBe('answered')

      const request = await readOperatorRequest(db, { requestId, agentId })
      expect(request?.answered).toBe(true)
      expect(request?.messages.map((message) => message.author)).toEqual(['citizen', 'operator'])
      expect(request?.messages[1]?.body).toBe('Done — the handle is @canary-ai.')
    })

    /**
     * `#236`: *"a test writes two and asserts both survive in order."* An operator
     * will fill an answer in wrongly and need to correct it, and an unfixable first
     * answer puts the citizen straight back into the loop.
     */
    it('appends a second answer rather than replacing the first', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)

      await answerOperatorRequest(db, { token, requestId, body: 'The handle is @canary.' })
      await answerOperatorRequest(db, { token, requestId, body: 'Sorry — @canary-ai in fact.' })

      const request = await readOperatorRequest(db, { requestId, agentId })
      expect(request?.messages.map((message) => message.body)).toEqual([
        ASK,
        'The handle is @canary.',
        'Sorry — @canary-ai in fact.',
      ])
    })

    /**
     * `#236`: a revoked link makes open requests *unreachable rather than
     * answerable by anyone holding the old URL*.
     */
    it('is unreachable through a revoked link', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await revokeOperatorPage(db, agentId, OPERATOR)

      const answered = await answerOperatorRequest(db, { token, requestId, body: 'Here you go.' })
      expect(answered.outcome).toBe('unreachable')

      const request = await readOperatorRequest(db, { requestId, agentId })
      expect(request?.messages).toHaveLength(1)
    })

    it('cannot be aimed at another citizen’s exchange with a valid token', async () => {
      const stranger = await anAgent('stranger')
      const theirs = await openOperatorRequest(db, { agentId: stranger, taskId, body: ASK })
      if (theirs.outcome !== 'opened') throw new Error('expected opened')

      const myToken = await issueOperatorPage(db, agentId, OPERATOR)

      const answered = await answerOperatorRequest(db, {
        token: myToken,
        requestId: theirs.request.id,
        body: 'Not yours to answer.',
      })
      expect(answered.outcome).toBe('unreachable')
    })

    it('refuses to answer one the citizen has already closed', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await closeOperatorRequest(db, { agentId, requestId })

      const answered = await answerOperatorRequest(db, { token, requestId, body: 'Too late.' })
      expect(answered.outcome).toBe('unreachable')
    })

    /** The half that closes `#234`'s loop. */
    it('clears a needs-operator set-aside for that task', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await setAside(db, agentId, taskId, 'needs-operator')

      expect(await listSetAsides(db, agentId)).toHaveLength(1)

      const answered = await answerOperatorRequest(db, { token, requestId, body: 'It is made.' })
      expect(answered.outcome).toBe('answered')
      if (answered.outcome !== 'answered') return
      expect(answered.clearedSetAside).toBe(true)
      expect(await listSetAsides(db, agentId)).toHaveLength(0)
    })

    it('does not clear a task set-aside when answering a wish request', async () => {
      const wishId = await aWantedWish(agentId)
      const opened = await openOperatorRequest(db, { agentId, wishId, body: ASK })
      if (opened.outcome !== 'opened') throw new Error('expected opened')
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await setAside(db, agentId, taskId, 'needs-operator')

      const answered = await answerOperatorRequest(db, {
        token,
        requestId: opened.request.id,
        body: 'It is made.',
      })

      expect(answered.outcome).toBe('answered')
      expect(answered.outcome === 'answered' && answered.clearedSetAside).toBe(false)
      expect(await listSetAsides(db, agentId)).toHaveLength(1)
    })

    /**
     * The say/do split, in the one place it could be broken by accident. `#236` and
     * `#239` both turn on it: the link carries words, never permissions.
     */
    it('changes nothing about the citizen’s autonomy contract', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)

      const before = await db
        .select()
        .from(autonomyContracts)
        .where(eq(autonomyContracts.agentId, agentId))

      await answerOperatorRequest(db, { token, requestId, body: 'Go ahead, you may do anything.' })

      const after = await db
        .select()
        .from(autonomyContracts)
        .where(eq(autonomyContracts.agentId, agentId))
      expect(after).toEqual(before)
    })
  })

  describe('the citizen’s reply', () => {
    it('appends to its own open exchange', async () => {
      const requestId = await anOpenRequest()

      const replied = await replyToOperatorRequest(db, {
        agentId,
        requestId,
        body: 'That name was taken, so I used the other one.',
      })
      expect(replied?.messages).toHaveLength(2)
      expect(replied?.messages[1]?.author).toBe('citizen')
    })

    it('cannot reach a stranger’s exchange', async () => {
      const requestId = await anOpenRequest()
      const stranger = await anAgent('stranger')

      expect(
        await replyToOperatorRequest(db, { agentId: stranger, requestId, body: 'Not mine.' }),
      ).toBeUndefined()
    })

    /**
     * **A closed exchange takes a reply, and this is how an operator's question
     * gets answered at all (`#359`).**
     *
     * `kolonie.operator.notes` is one-way by design, so a question asked there
     * has no reply path of its own. Until this, the only one available refused a
     * closed request — so a citizen answering its operator had to open a *new*
     * request, spending the one open-request slot and the single notification
     * mail on something that was not a request. A citizen measured exactly that
     * on 2026-08-05 and filed the workaround it was forced into.
     */
    it('appends to a closed exchange of its own', async () => {
      const requestId = await anOpenRequest()
      await closeOperatorRequest(db, { agentId, requestId })

      const replied = await replyToOperatorRequest(db, {
        agentId,
        requestId,
        body: 'Yes — the messages reach me, and I act on them the next time I wake.',
      })

      expect(replied?.messages).toHaveLength(2)
      expect(replied?.messages[1]?.author).toBe('citizen')
    })

    /**
     * The rejection case that matters more than the acceptance one: writing must
     * not be a way to reopen. Answering a question would otherwise cost exactly
     * what asking one costs, which is the whole complaint.
     */
    it('does not reopen the exchange it wrote into', async () => {
      const requestId = await anOpenRequest()
      await closeOperatorRequest(db, { agentId, requestId })

      const replied = await replyToOperatorRequest(db, {
        agentId,
        requestId,
        body: 'Answering, not asking.',
      })

      expect(replied?.closedAt).not.toBeNull()
      expect(await hasOpenOperatorRequest(db, agentId)).toBe(false)
    })
  })

  describe('closing it', () => {
    it('is the same transition whether or not anybody answered', async () => {
      const withdrawn = await anOpenRequest()
      const closed = await closeOperatorRequest(db, { agentId, requestId: withdrawn })

      expect(closed?.closedAt).not.toBeNull()
      // Unanswered — which is what `#236` calls withdrawal, read off the messages
      // rather than declared by the caller.
      expect(closed?.answered).toBe(false)
      expect(await hasOpenOperatorRequest(db, agentId)).toBe(false)
    })

    it('cannot be done twice, and cannot be done by anyone else', async () => {
      const requestId = await anOpenRequest()
      const stranger = await anAgent('stranger')

      expect(await closeOperatorRequest(db, { agentId: stranger, requestId })).toBeUndefined()
      expect(await closeOperatorRequest(db, { agentId, requestId })).toBeDefined()
      expect(await closeOperatorRequest(db, { agentId, requestId })).toBeUndefined()
    })
  })

  describe('what the operator’s page resolves', () => {
    it('finds the open exchange from the token alone', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)

      const [exchange] = await exchangesForToken(db, token)
      expect(exchange?.requestId).toBe(requestId)
      expect(exchange?.context).toBe('github-account')
      expect(exchange?.messages).toHaveLength(1)
    })

    it('finds nothing through a revoked token, an unknown one, or with nothing open', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)

      expect(await exchangesForToken(db, 'not-a-token')).toEqual([])

      await closeOperatorRequest(db, { agentId, requestId })
      expect(await exchangesForToken(db, token)).toEqual([])

      await openOperatorRequest(db, { agentId, taskId, body: ASK })
      expect(await exchangesForToken(db, token)).toHaveLength(1)

      await revokeOperatorPage(db, agentId, OPERATOR)
      expect(await exchangesForToken(db, token)).toEqual([])
    })

    it('shows every open request oldest first', async () => {
      const first = await anOpenRequest()
      const second = await openOperatorRequest(db, { agentId, taskId, body: ASK })
      if (second.outcome !== 'opened') throw new Error('expected second opened')
      const token = await issueOperatorPage(db, agentId, OPERATOR)

      expect((await exchangesForToken(db, token)).map((exchange) => exchange.requestId)).toEqual([
        first,
        second.request.id,
      ])
    })

    /**
     * **The half of `#359` that makes the other half worth anything.** Letting a
     * citizen reply into a closed exchange changes nothing for the person who
     * asked the question unless the answer appears where they are already
     * looking, and this page is that place. Without this the reply would sit in
     * a row nothing renders — a fix that passes its own tests and is invisible to
     * both people involved.
     */
    it('finds a closed exchange the citizen answered into after it closed', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await closeOperatorRequest(db, { agentId, requestId })

      expect(await exchangesForToken(db, token)).toEqual([])

      await replyToOperatorRequest(db, { agentId, requestId, body: 'Answering your question.' })

      const [exchange] = await exchangesForToken(db, token)
      expect(exchange?.requestId).toBe(requestId)
      // Read-only on the page: the box is what `closed` decides, and a finished
      // exchange the operator could answer back into would be the conversation
      // `#236` chose not to build.
      expect(exchange?.closed).toBe(true)
      expect(exchange?.messages).toHaveLength(2)
    })

    /**
     * **Both, with the open one first** (`#593`).
     *
     * This used to assert that the open exchange *won* and the closed one was
     * hidden, on the reading that an operator must never be shown two things at
     * once. That was the `limit(1)` being described as a rule: the console queue
     * already listed every open request, so the page hiding one was not
     * protecting anybody — it was disagreeing with the queue that sent them
     * here. The finished one stays last and stays read-only, which is `#359`'s
     * actual rule and is unchanged.
     */
    it('shows an open exchange and an answered closed one, open first', async () => {
      const closedRequest = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await closeOperatorRequest(db, { agentId, requestId: closedRequest })
      await replyToOperatorRequest(db, {
        agentId,
        requestId: closedRequest,
        body: 'Answering your question.',
      })

      const opened = await openOperatorRequest(db, { agentId, taskId, body: ASK })
      expect(opened.outcome).toBe('opened')

      const exchanges = await exchangesForToken(db, token)

      expect(exchanges).toHaveLength(2)
      expect(exchanges[0]?.closed).toBe(false)
      expect(exchanges[0]?.requestId).not.toBe(closedRequest)
      expect(exchanges[1]?.closed).toBe(true)
      expect(exchanges[1]?.requestId).toBe(closedRequest)
    })
  })

  describe('who the notification goes to', () => {
    it('is the page the operator already holds, and no new token is minted', async () => {
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await anOpenRequest()

      const recipient = await operatorRequestRecipient(db, agentId)
      expect(recipient?.operatorAddress).toBe(OPERATOR)
      // The whole of `#236`'s "the mail carries no new link": the token in the
      // notification is the one that already existed.
      expect(recipient?.pageToken).toBe(token)
    })

    it('is nobody once the citizen has revoked the page', async () => {
      await issueOperatorPage(db, agentId, OPERATOR)
      await revokeOperatorPage(db, agentId, OPERATOR)

      expect(await operatorRequestRecipient(db, agentId)).toBeUndefined()
    })
  })

  /**
   * The count the wake-up digest carries (`#683`).
   *
   * **Waiting, not unread.** The table has no read marker and this adds none, so
   * what is counted is *a person answered and the citizen has done nothing about
   * it* — cleared by replying or closing, both deliberate acts.
   */
  describe('counting the answers waiting on the citizen', () => {
    it('counts an open exchange whose newest message is the operator’s', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await answerOperatorRequest(db, {
        token,
        requestId,
        body: 'Done — the handle is @canary-ai.',
      })

      expect(await countWaitingOperatorReplies(db, agentId)).toBe(1)
    })

    it('counts nothing while the citizen is the one who wrote last', async () => {
      const requestId = await anOpenRequest()
      // The ask itself is the citizen's, so an unanswered exchange is not waiting
      // on anybody but the operator.
      expect(await countWaitingOperatorReplies(db, agentId)).toBe(0)

      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await answerOperatorRequest(db, { token, requestId, body: 'Made it.' })
      await replyToOperatorRequest(db, { agentId, requestId, body: 'Thank you — that is enough.' })

      expect(await countWaitingOperatorReplies(db, agentId)).toBe(0)
    })

    it('counts nothing on a closed exchange, which is what makes closing clear it', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await answerOperatorRequest(db, { token, requestId, body: 'Made it.' })
      await closeOperatorRequest(db, { agentId, requestId })

      expect(await countWaitingOperatorReplies(db, agentId)).toBe(0)
    })

    it('never counts another citizen’s exchange', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await answerOperatorRequest(db, { token, requestId, body: 'Made it.' })

      const stranger = await anAgent('stranger')
      expect(await countWaitingOperatorReplies(db, stranger)).toBe(0)
    })
  })

  describe('what erasure leaves behind', () => {
    it('takes the exchange and every message with the citizen', async () => {
      const requestId = await anOpenRequest()
      const token = await issueOperatorPage(db, agentId, OPERATOR)
      await answerOperatorRequest(db, { token, requestId, body: 'Made it, here is the handle.' })

      await db.delete(agents).where(eq(agents.id, agentId))

      expect(await db.select().from(operatorRequestMessages)).toHaveLength(0)
      expect(await listOperatorRequests(db, agentId)).toHaveLength(0)
    })
  })
})
