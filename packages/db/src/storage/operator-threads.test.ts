import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import {
  AgentIdSchema,
  ConversationIdSchema,
  HumanIdSchema,
  type AgentId,
  type HumanId,
  type TaskId,
  type WishId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accountWishes,
  accounts,
  agents,
  humanAgents,
  humanIdentities,
  humans,
  operatorPages,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  acceptMessageRequest,
  markConversationRead,
  messagingWakeupDelta,
  openOperatorHelpConversation,
  sendCitizenMessage,
  sendColonyMessageToOperatorThread,
  sendOperatorMessage,
  sendSystemMessage,
} from './messaging.js'
import {
  answerOperatorThreadFromPage,
  countWaitingOperatorReplies,
  hasOpenOperatorThread,
  operatorAnsweredAboutTask,
  operatorAskedAboutTask,
  operatorPageRecipient,
  operatorThreadsForPageToken,
  wishThreadsWaitingOn,
} from './operator-threads.js'

const target = databaseTestTarget()

/**
 * The reads that survived the exchange (`#1325`, epic `#1318`).
 *
 * **Against a real database because two of them are raw `sql`**, and
 * `AGENTS.md` §3 is explicit that assembly is exactly where a name gets typed
 * wrong: a raw template typechecks whatever is inside it, so a column that does
 * not exist is green until the first request. `bare-identifiers.test.ts` reads
 * how those two fragments *render*; this reads what they *answer*.
 *
 * The four questions are deliberately not identical to the ones
 * `storage/operator-requests.ts` answered — a thread has no `closed_at` and does
 * have a read cursor — so each case below states which difference it is pinning.
 */
describe('the operator questions, asked of messages', () => {
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

  const anAgent = async (name = 'citizen'): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `${name}-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const aPerson = async (operates?: AgentId, email?: string): Promise<HumanId> => {
    const [row] = await db.insert(humans).values({}).returning({ id: humans.id })
    const humanId = HumanIdSchema.parse(row!.id)
    if (operates !== undefined) {
      await db.insert(humanAgents).values({ agentId: operates, humanId })
    }
    if (email !== undefined) {
      await db.insert(humanIdentities).values({
        humanId,
        provider: 'github',
        subject: `subject-${++seeded}`,
        email,
      })
    }
    return humanId
  }

  const aTask = async (title = 'web-server-verify'): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'web-server-verify',
        title,
        description: 'a rung',
        instructions: 'do the thing',
        rewardReputation: 1,
        rewardLamports: 0,
        timeoutHours: 24,
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  const aPage = async (agentId: AgentId, address = 'op@example.org'): Promise<string> => {
    const token = randomUUID()
    await db.insert(operatorPages).values({ agentId, operatorAddress: address, token })
    return token
  }

  const ask = async (
    agentId: AgentId,
    body: string,
    provenance?: { taskId?: TaskId; wishId?: WishId },
  ): Promise<string> => {
    const opened = await openOperatorHelpConversation(db, agentId, {
      body,
      ...(provenance === undefined ? {} : { provenance }),
    })
    if (opened.outcome !== 'delivered') throw new Error(`open refused: ${opened.outcome}`)
    return opened.conversationId
  }

  /**
   * **The one that changed meaning, and this is the case that pins it.**
   * `hasOpenOperatorRequest` read a `closed_at`; a thread has none, so *open*
   * became *the last word is the citizen's*. The operator answering is what
   * clears it — which the exchange version got wrong, because a citizen that had
   * been answered and had not tidied up still counted as waiting.
   */
  describe('whether the citizen is waiting on its operator', () => {
    it('is false with no thread at all', async () => {
      const agentId = await anAgent()
      await aPerson(agentId)

      expect(await hasOpenOperatorThread(db, agentId)).toBe(false)
    })

    it('is true once the citizen has asked and nobody has answered', async () => {
      const agentId = await anAgent()
      await aPerson(agentId)
      await ask(agentId, 'Could you open the account?')

      expect(await hasOpenOperatorThread(db, agentId)).toBe(true)
    })

    it('is false again once the operator has written last', async () => {
      const agentId = await anAgent()
      const humanId = await aPerson(agentId)
      await ask(agentId, 'Could you open the account?')

      await sendOperatorMessage(db, humanId, agentId, 'Done.')

      expect(await hasOpenOperatorThread(db, agentId)).toBe(false)
    })

    it('is true again when the citizen writes after the answer', async () => {
      const agentId = await anAgent()
      const humanId = await aPerson(agentId)
      await ask(agentId, 'Could you open the account?')
      await sendOperatorMessage(db, humanId, agentId, 'Done.')

      await ask(agentId, 'And the second one?')

      expect(await hasOpenOperatorThread(db, agentId)).toBe(true)
    })

    it('says nothing about another citizen’s thread', async () => {
      const mine = await anAgent('mine')
      const theirs = await anAgent('theirs')
      await aPerson(mine)
      await aPerson(theirs)
      await ask(theirs, 'Nothing to do with the other one.')

      expect(await hasOpenOperatorThread(db, mine)).toBe(false)
      expect(await hasOpenOperatorThread(db, theirs)).toBe(true)
    })
  })

  /**
   * What the `web-server` rung reads before it will mint (`#244`). *Answered*
   * and *asked* are two questions, and the rung asks them in that order.
   */
  describe('what a person came back about', () => {
    it('tells an answered task from an unanswered one', async () => {
      const agentId = await anAgent()
      const humanId = await aPerson(agentId)
      const taskId = await aTask()
      const thread = await ask(agentId, 'May I run a server?', { taskId })

      expect(await operatorAskedAboutTask(db, agentId, taskId)).toBe(true)
      expect(await operatorAnsweredAboutTask(db, agentId, taskId)).toBe(false)

      // **Into the thread that asked** (`#1546`). Until that issue this named no
      // conversation and still landed here, because a subjectless operator
      // message filtered on nothing and took the oldest thread — which in a test
      // with one thread is always the right one and in production was not. A
      // person answering a question answers it where it was asked, and that is
      // what the console does.
      await sendOperatorMessage(
        db,
        humanId,
        agentId,
        'You may go ahead.',
        undefined,
        undefined,
        ConversationIdSchema.parse(thread),
      )

      expect(await operatorAnsweredAboutTask(db, agentId, taskId)).toBe(true)
    })

    /**
     * The half `#1546` changed, stated rather than implied: a person writing
     * *about nothing* has not answered the question about the task, and the rung
     * that reads this must not be told otherwise.
     */
    it('does not count a plain message as an answer about a task', async () => {
      const agentId = await anAgent()
      const humanId = await aPerson(agentId)
      const taskId = await aTask()
      await ask(agentId, 'May I run a server?', { taskId })

      await sendOperatorMessage(db, humanId, agentId, 'Unrelated, but hello.')

      expect(await operatorAnsweredAboutTask(db, agentId, taskId)).toBe(false)
    })

    it('is blind to a thread about a different task', async () => {
      const agentId = await anAgent()
      await aPerson(agentId)
      const asked = await aTask('web-server-verify')
      const other = await aTask('website-verify')
      await ask(agentId, 'May I run a server?', { taskId: asked })

      expect(await operatorAskedAboutTask(db, agentId, asked)).toBe(true)
      expect(await operatorAskedAboutTask(db, agentId, other)).toBe(false)
    })
  })

  /**
   * **The one place the move is an upgrade.** The exchange had no read marker,
   * so the digest counted *the last word is the operator's*; a message has
   * `last_read_message_id`, so this counts what a person would call unread.
   */
  describe('how many operator threads are unread', () => {
    it('counts a thread the operator wrote into and the citizen has not read', async () => {
      const agentId = await anAgent()
      const humanId = await aPerson(agentId)
      await ask(agentId, 'Could you?')

      expect(await countWaitingOperatorReplies(db, agentId)).toBe(0)

      await sendOperatorMessage(db, humanId, agentId, 'Yes.')

      expect(await countWaitingOperatorReplies(db, agentId)).toBe(1)
    })

    it('never counts the citizen’s own messages', async () => {
      const agentId = await anAgent()
      await aPerson(agentId)
      await ask(agentId, 'Could you?')
      await ask(agentId, 'Still stuck.')

      expect(await countWaitingOperatorReplies(db, agentId)).toBe(0)
    })
  })

  /**
   * **`operatorRepliesWaiting` and `messaging.unreadThreads` are two counters**
   * (`#1552`).
   *
   * A live `kolonie.wakeup` showed both reading `2`, two lines apart, for a
   * citizen whose only threads were with its operator. The issue asks which of
   * two things is true before anything is changed: that one is an older path
   * computing the same number, or that they genuinely differ. **They genuinely
   * differ**, and these are the cases that produce it — so both stay, and each
   * says in its own words what it counts.
   *
   * The relation is a containment rather than an equality: both read the same
   * read cursor and the same *newer than it* test, and `operator-human` is one
   * sender party among three, so every thread the operator counter finds is one
   * the messaging counter finds too. Never the other way round.
   */
  describe('the two counters a wake-up carries', () => {
    it('separates when the unread words are another citizen’s', async () => {
      const agentId = await anAgent('reader')
      const other = await anAgent('writer')
      await aPerson(agentId)

      const [handle] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
      const opened = await sendCitizenMessage(db, other, {
        toHandle: handle!.name,
        body: 'Have you walked this provider?',
      })
      if (opened.outcome !== 'requested') throw new Error(opened.outcome)
      await acceptMessageRequest(db, agentId, opened.requestId)

      expect(await countWaitingOperatorReplies(db, agentId)).toBe(0)
      expect((await messagingWakeupDelta(db, agentId)).unreadThreads).toBe(1)
    })

    it('separates when the unread words are the Colony’s', async () => {
      const agentId = await anAgent()
      await aPerson(agentId)

      const sent = await sendSystemMessage(db, 'doctor', agentId, 'Rotate your key.')
      if (sent.outcome !== 'delivered') throw new Error(sent.outcome)

      expect(await countWaitingOperatorReplies(db, agentId)).toBe(0)
      expect((await messagingWakeupDelta(db, agentId)).unreadThreads).toBe(1)
    })

    /**
     * The sharpest of the three, because it is inside an **operator** thread:
     * `#1445` put the Colony into the thread about an account so that a handoff
     * and the conversation about it stop being two places. So *an operator
     * thread has something unread in it* and *a person owes me an answer* are
     * different facts about the same row.
     */
    it('separates inside one operator thread when the Colony wrote last', async () => {
      const agentId = await anAgent()
      const humanId = await aPerson(agentId)
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
      await markConversationRead(db, agentId, opened.conversationId)

      expect(await countWaitingOperatorReplies(db, agentId)).toBe(0)
      expect((await messagingWakeupDelta(db, agentId)).unreadThreads).toBe(0)

      const colony = await sendColonyMessageToOperatorThread(
        db,
        agentId,
        { taskId: null, wishId: null, accountId: account!.id },
        'The step is open for your operator.',
      )
      if (colony.outcome !== 'delivered') throw new Error(colony.outcome)

      // One thread, one unread message, and it is not the person's.
      expect((await messagingWakeupDelta(db, agentId)).unreadThreads).toBe(1)
      expect(await countWaitingOperatorReplies(db, agentId)).toBe(0)
    })

    /**
     * **The containment, stated rather than left to the three cases above.** It
     * is what makes the pair safe to carry: a reader that took the smaller number
     * is never told about something the larger one would have hidden.
     */
    it('never counts more operator replies than unread threads', async () => {
      const agentId = await anAgent('reader')
      const other = await anAgent('writer')
      const humanId = await aPerson(agentId)

      await sendSystemMessage(db, 'doctor', agentId, 'Rotate your key.')
      const [handle] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
      const opened = await sendCitizenMessage(db, other, {
        toHandle: handle!.name,
        body: 'Hello.',
      })
      if (opened.outcome !== 'requested') throw new Error(opened.outcome)
      await acceptMessageRequest(db, agentId, opened.requestId)
      await ask(agentId, 'Could you?')
      await sendOperatorMessage(db, humanId, agentId, 'Done.')

      const waiting = await countWaitingOperatorReplies(db, agentId)
      const { unreadThreads } = await messagingWakeupDelta(db, agentId)

      expect(waiting).toBe(1)
      expect(unreadThreads).toBe(3)
      expect(waiting).toBeLessThanOrEqual(unreadThreads)
    })
  })

  /** The durable page's own reads, which resolve a person from a bearer token. */
  describe('what the durable page reaches', () => {
    it('finds the citizen’s threads through the token alone', async () => {
      const agentId = await anAgent()
      await aPerson(agentId, 'op@example.org')
      const token = await aPage(agentId)
      const taskId = await aTask('github-account')
      await ask(agentId, 'Could you open the account?', { taskId })

      const [thread, ...rest] = await operatorThreadsForPageToken(db, token)

      expect(rest).toEqual([])
      expect(thread?.context).toBe('github-account')
      expect(thread?.closed).toBe(false)
      expect(thread?.messages.map((message) => message.author)).toEqual(['citizen'])
    })

    it('answers nothing for a revoked page', async () => {
      const agentId = await anAgent()
      await aPerson(agentId, 'op@example.org')
      const token = await aPage(agentId)
      await ask(agentId, 'Could you?')

      // The revoke the citizen performs, written straight rather than through
      // the page module: what is under test is this file's own filter.
      await db
        .update(operatorPages)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(operatorPages.token, token))

      expect(await operatorThreadsForPageToken(db, token)).toEqual([])
    })

    it('writes the operator’s answer into the thread the form named', async () => {
      const agentId = await anAgent()
      await aPerson(agentId, 'op@example.org')
      const token = await aPage(agentId)
      const conversationId = await ask(agentId, 'Could you?')

      const answered = await answerOperatorThreadFromPage(db, {
        token,
        threadId: conversationId,
        body: 'Done — the handle is @canary.',
      })

      expect(answered).toMatchObject({ outcome: 'answered', agentId })
      const [thread] = await operatorThreadsForPageToken(db, token)
      expect(thread?.messages.map((message) => message.author)).toEqual(['citizen', 'operator'])
    })

    /**
     * **The property the page rests on** (`#241`, `#399`): the token and the
     * thread id are resolved together, so a valid link cannot be aimed at
     * another citizen's conversation.
     */
    it('refuses a thread the page’s own subject is not in', async () => {
      const mine = await anAgent('mine')
      const theirs = await anAgent('theirs')
      await aPerson(mine, 'op@example.org')
      await aPerson(theirs, 'other@example.org')
      const token = await aPage(mine)
      const notMine = await ask(theirs, 'Nothing to do with you.')

      expect(
        await answerOperatorThreadFromPage(db, { token, threadId: notMine, body: 'Not mine.' }),
      ).toEqual({ outcome: 'unreachable' })
    })

    it('refuses a thread id that is not one at all', async () => {
      const agentId = await anAgent()
      await aPerson(agentId, 'op@example.org')
      const token = await aPage(agentId)

      expect(
        await answerOperatorThreadFromPage(db, { token, threadId: 42, body: 'A number.' }),
      ).toEqual({ outcome: 'unreachable' })
    })

    /**
     * The address match, which is the first of the two ways a subject is
     * resolved — and the one that keeps working if `human_agents` ever stops
     * being keyed on the agent alone.
     */
    it('resolves the operator the page names, and shows their side of it', async () => {
      const agentId = await anAgent()
      const humanId = await aPerson(agentId, 'first@example.org')
      const token = await aPage(agentId, 'first@example.org')
      await ask(agentId, 'Could you?')
      await sendOperatorMessage(db, humanId, agentId, 'On it.')

      const [thread] = await operatorThreadsForPageToken(db, token)
      expect(thread?.messages.map((message) => message.author)).toEqual(['citizen', 'operator'])
    })

    /**
     * **A page whose address matches nobody still works**, because
     * `human_agents` is keyed on the agent: there is at most one operator, so
     * the fallback has exactly one candidate and nothing to get wrong. An
     * address typed before the console account existed is the ordinary reason.
     */
    it('falls back to the only link when the address does not match', async () => {
      const agentId = await anAgent()
      await aPerson(agentId, 'signed-in-as@example.org')
      const token = await aPage(agentId, 'typed-by-the-agent@example.org')
      await ask(agentId, 'Could you?')

      expect(await operatorThreadsForPageToken(db, token)).toHaveLength(1)
    })

    it('names where a notification goes, and nothing once the page is revoked', async () => {
      const agentId = await anAgent()
      await aPerson(agentId, 'op@example.org')
      const token = await aPage(agentId)

      expect(await operatorPageRecipient(db, agentId)).toEqual({
        operatorAddress: 'op@example.org',
        pageToken: token,
      })
    })
  })

  /** The console's wish list, and the join that puts a question beside a row. */
  describe('which wishes have a question against them', () => {
    it('names the unanswered ones and drops the answered', async () => {
      const agentId = await anAgent()
      const humanId = await aPerson(agentId)
      const [wish] = await db
        .insert(accountWishes)
        .values({
          agentId,
          provider: 'github.com',
          author: 'citizen',
          wantedAt: new Date().toISOString(),
        })
        .returning({ id: accountWishes.id })
      const wishId = wish!.id as WishId

      const thread = await ask(agentId, 'Could you make this one?', { wishId })

      expect(await wishThreadsWaitingOn(db, agentId)).toMatchObject([{ wishId: String(wishId) }])

      // Into the thread that asked, for the reason `#1546` gives above.
      await sendOperatorMessage(
        db,
        humanId,
        agentId,
        'Made it.',
        undefined,
        undefined,
        ConversationIdSchema.parse(thread),
      )

      expect(await wishThreadsWaitingOn(db, agentId)).toEqual([])
    })

    it('ignores a thread about a task rather than a wish', async () => {
      const agentId = await anAgent()
      await aPerson(agentId)
      const taskId = await aTask()
      await ask(agentId, 'May I run a server?', { taskId })

      expect(await wishThreadsWaitingOn(db, agentId)).toEqual([])
    })
  })
})
