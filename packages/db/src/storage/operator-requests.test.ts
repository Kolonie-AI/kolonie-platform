import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AgentId, OperatorRequestId, TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agents,
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
      expect(opened.request.taskTitle).toBe('github-account')
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
    it('refuses a second while the first is open, and names the open one', async () => {
      const first = await anOpenRequest()
      const second = await openOperatorRequest(db, { agentId, taskId, body: ASK })

      expect(second.outcome).toBe('already-open')
      if (second.outcome !== 'already-open') return
      expect(second.openRequestId).toBe(first)
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

    /**
     * The index rather than the `select` is what enforces one-at-a-time, so it is
     * asserted against the database directly: a check in the write path is one two
     * concurrent calls can both pass.
     */
    it('is refused by the database itself, not only by the read above it', async () => {
      await anOpenRequest()

      await expectRejection(
        () => db.insert(operatorRequests).values({ agentId, taskId }),
        /operator_requests_one_open_idx/,
      )
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
      expect(exchange?.taskTitle).toBe('github-account')
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

    /**
     * **`#593` says an agent can have two open questions, and it cannot** —
     * `operator_requests_one_open_idx` is a partial unique index on `agent_id`
     * where `closed_at is null`, so the database refuses the second. Verified
     * against production 2026-08-08: no agent has more than one.
     *
     * The test is here rather than the two-open-exchange one the issue asked
     * for, because a test asserting a state the schema forbids would be a test
     * asserting a fiction. What `#593` describes an operator seeing is real and
     * is the anchor problem `#587` fixes.
     */
    it('refuses a second open request, which is why one can never be picked wrongly', async () => {
      const first = await anOpenRequest()

      const second = await openOperatorRequest(db, { agentId, taskId, body: ASK })

      expect(second.outcome).toBe('already-open')
      expect(second.outcome === 'already-open' ? second.openRequestId : undefined).toBe(first)
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
