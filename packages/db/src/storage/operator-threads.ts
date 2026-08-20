import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  ConversationIdSchema,
  type AgentId,
  type ConversationId,
  type HumanId,
  type OperatorAnswerKind,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { sendOperatorMessage } from './messaging.js'
import {
  accountWishes,
  accounts,
  humanAgents,
  humanIdentities,
  messageConversationShares,
  messageConversations,
  messageParticipants,
  messages,
  operatorPages,
  tasks,
  vaultShares,
} from '../schema/index.js'
import { openVaultValue, vaultDescriptionScope } from '../vault-crypto.js'

/**
 * The four questions the Colony asks about a citizen's operator thread
 * (`#1325`, epic `#1318`).
 *
 * **What `storage/operator-requests.ts` answered, asked of `messages` instead.**
 * Retiring the exchange did not retire the questions: a rung whose consequences
 * land on somebody else's machine still has to know whether a person came back,
 * and the wake-up still has to know whether anything is outstanding. Each one
 * below names the function it replaces, because the semantics are deliberately
 * *not* identical everywhere and the differences are the interesting part.
 *
 * **Its own file rather than four more exports on `messaging.ts`.** `AGENTS.md`
 * §3: independent work gets independent files, and `messaging.ts` is already the
 * most contended file in this package. Nothing here writes, so there is no
 * transaction to share with the sending path either.
 *
 * **Reads, never verdicts.** The rule `operatorAnsweredAbout` set survives the
 * move word for word: the Colony records that a person was asked and replied,
 * and reads no meaning out of what they wrote. Judging whether a sentence means
 * yes is a thing it would get wrong, and getting it wrong in the permissive
 * direction would mean the Colony deciding an operator had consented.
 */

/** The operator's side of a thread, so a message can be attributed without a join per row. */
const operatorSide = alias(messageParticipants, 'operator_side')

/** Where an answer may be written, and to whom the notification goes. */
export interface OperatorPageRecipient {
  readonly operatorAddress: string
  /** The token the operator already holds. Never minted per ask (`#236`). */
  readonly pageToken: string
}

/**
 * Where a notification for this citizen should go.
 *
 * **It returns the token the operator already holds.** `#236` refuses to mint a
 * fresh link per ask: a new credential in an inbox every time an agent needs
 * something buys nothing over the one the operator has, and costs one more thing
 * that can leak. `issueOperatorPage` is idempotent, so the caller that wants a
 * page created if none exists asks for it there and then comes here.
 *
 * `undefined` when the citizen has no live page — which is also the answer when
 * it had one and revoked it, because `#236` requires a revoked link to make an
 * open ask *unreachable rather than answerable by anyone holding the old URL*.
 */
export async function operatorPageRecipient(
  db: Database,
  agentId: AgentId,
): Promise<OperatorPageRecipient | undefined> {
  const [row] = await db
    .select({ operatorAddress: operatorPages.operatorAddress, token: operatorPages.token })
    .from(operatorPages)
    .where(and(eq(operatorPages.agentId, agentId), isNull(operatorPages.revokedAt)))
    .orderBy(desc(operatorPages.issuedAt))
    .limit(1)

  if (row === undefined) return undefined

  return { operatorAddress: row.operatorAddress, pageToken: row.token }
}

const asConversationId = (value: string): ConversationId => ConversationIdSchema.parse(value)

/** One message in an operator thread, in the shape the durable page already renders. */
export interface OperatorThreadMessage {
  /**
   * Who wrote it — three, not two, since `#1445`.
   *
   * **`colony` used to be folded into `citizen`**, and that was defensible while
   * the only Colony messages in an operator thread were notices *about* the
   * citizen. `kolonie.accounts.handoff` changes it: the ask a person reads is
   * composed by the Colony from a recipe and **no agent could have authored it**,
   * which is the anti-injection property `packages/core/src/operator/handover.ts`
   * states as constraint 4. A person can only rely on that if they can see it,
   * so the third value exists and the page renders it differently.
   */
  readonly author: 'citizen' | 'operator' | 'colony'
  readonly body: string
  readonly kind: OperatorAnswerKind | null
  readonly writtenAt: string
}

/** One operator thread, as the person holding the page reads it. */
export interface OperatorThreadForPage {
  readonly threadId: ConversationId
  /** The task title or the wish provider — what this thread is about, in a person's words. */
  readonly context: string
  readonly openedAt: string
  readonly messages: readonly OperatorThreadMessage[]
  /**
   * Whether the page renders a box under it.
   *
   * True when the operator link has been removed: the thread stays readable and
   * stops accepting words, which is the same read-only state
   * `replyInConversation` gives the citizen's side (`operator-link-removed`).
   */
  readonly closed: boolean
  /**
   * The account this thread is about, by identifier (`#1442`).
   *
   * Null for a thread about a task, a wish, or nothing. `context` above already
   * carries the identifier as text, and this is the *fact* rather than the
   * phrase: the page renders the shares under an account rather than under a
   * sentence, and a renderer branching on prose is one that breaks the day the
   * prose is reworded.
   */
  readonly accountIdentifier: string | null
  /**
   * The entries shared onto this thread, with their values (`#1442`).
   *
   * **The assembly is the whole of `#1442`.** After `#1439`–`#1441` a person can
   * read a share, and a thread can name an account, and the two are separate
   * things on separate parts of the page — which is precisely the shape that
   * made drops fail: *the secret and the reason for it lived in different
   * places*. Here they are one object.
   */
  readonly shares: readonly OperatorThreadShare[]
  /**
   * What has happened to those shares, in order (`#1442`).
   *
   * **Derived from the share's own timestamps, not written as messages.** A
   * share is state on the conversation with one lifecycle, and turning it into
   * chat entries would make it something that can be sent, quoted and forwarded
   * — which `#1442` names as the thing to get right. The events are read out of
   * `vault_shares` on every render and stored nowhere.
   */
  readonly shareEvents: readonly OperatorThreadShareEvent[]
}

/** One shared entry, as the person reading the thread sees it. */
export interface OperatorThreadShare {
  readonly id: string
  readonly vaultKey: string
  readonly purpose: string
  readonly expiresAt: string
  readonly value: string
  readonly description: string | null
  readonly wrote: boolean
}

/** One thing that happened to a share, placed in the thread by when it happened. */
export interface OperatorThreadShareEvent {
  readonly vaultKey: string
  readonly kind: 'shared' | 'read' | 'written' | 'handed-back'
  readonly at: string
}

/**
 * Who the durable page speaks as (`#1325`).
 *
 * **The token names the citizen; this names the person.** A page is issued to an
 * address rather than to an account, so the operator side of a thread has to be
 * resolved rather than carried — and it is resolved from rows the citizen's own
 * console relationship created, never from anything the caller sent.
 *
 * Two ways, in order, and no third. **The address the page was issued to**, when
 * a linked human holds it — the exact case, so a page issued to one of two
 * operators reaches that one's thread. Then **the only link there is**, when the
 * citizen has exactly one operator and the address did not match: an address
 * that was typed before the console account existed is the ordinary reason, and
 * with one candidate there is nothing to get wrong.
 *
 * `undefined` where neither holds — several operators and no address match — and
 * the page then shows notes and drops and no threads. Guessing between two
 * people would be showing one of them somebody else's conversation.
 */
async function pageSubject(
  db: Database,
  token: string,
): Promise<{ readonly agentId: AgentId; readonly humanId: string } | undefined> {
  const [page] = await db
    .select({ agentId: operatorPages.agentId, address: operatorPages.operatorAddress })
    .from(operatorPages)
    .where(and(eq(operatorPages.token, token), isNull(operatorPages.revokedAt)))
    .limit(1)

  if (page === undefined) return undefined

  /**
   * The address is on the identity rather than on the person, and a person may
   * have several — one per provider they signed in with. Any of them matching is
   * a match: the citizen was given a page for an address its operator uses, and
   * which provider returned it says nothing about who they are.
   */
  const links = await db
    .selectDistinct({ humanId: humanAgents.humanId, email: humanIdentities.email })
    .from(humanAgents)
    .leftJoin(humanIdentities, eq(humanIdentities.humanId, humanAgents.humanId))
    .where(eq(humanAgents.agentId, page.agentId))

  const wanted = page.address.trim().toLowerCase()
  const byAddress = links.find((link) => (link.email ?? '').trim().toLowerCase() === wanted)
  const people = new Set(links.map((link) => link.humanId))
  const only = people.size === 1 ? links[0] : undefined
  const chosen = byAddress ?? only

  return chosen === undefined
    ? undefined
    : { agentId: page.agentId as AgentId, humanId: chosen.humanId }
}

/**
 * The threads the durable page shows (`#1325`).
 *
 * Replaces `exchangesForToken`, and the ordering rule survives intact: oldest
 * first, with the id breaking a tie, because `#587`'s anchor depends on a stable
 * order and re-sorting anywhere else would be a second answer to *which question
 * is first*.
 *
 * **What does not survive is the *one closed one, at the end* rule** (`#359`).
 * That existed because an exchange could be closed while the citizen went on
 * writing into it, so an answer arriving afterwards had nowhere to appear. A
 * thread is never closed, so every thread is simply listed and the case is gone
 * rather than handled.
 *
 * **The token is the only input**, so the page cannot be pointed at another
 * citizen's thread, and a revoked token resolves to nothing — the same filter
 * `openOperatorPage` applies, kept here rather than trusted to the caller.
 */
export async function operatorThreadsForPageToken(
  db: Database,
  token: string,
  /**
   * The Colony's sealing key, where this deployment has one (`#1442`).
   *
   * **Optional, so a Colony without one still renders its threads.** Without it
   * the words are all there is, which is exactly what the page was before
   * `#1437` — and a thread that failed to render because a share could not be
   * opened would take the conversation down with the credential.
   */
  sealingKey?: string,
): Promise<readonly OperatorThreadForPage[]> {
  const subject = await pageSubject(db, token)
  if (subject === undefined) return []

  const rows = await db
    .select({
      id: messageConversations.id,
      createdAt: messageConversations.createdAt,
      context: sql<
        string | null
      >`coalesce(${tasks.title}, ${accountWishes.provider}, ${accounts.identifier})`,
      accountIdentifier: accounts.identifier,
      live: sql<boolean>`${operatorSide.id} is not null`,
    })
    .from(messageConversations)
    .innerJoin(
      messageParticipants,
      and(
        eq(messageParticipants.conversationId, messageConversations.id),
        eq(messageParticipants.agentId, subject.agentId),
      ),
    )
    .innerJoin(
      operatorSide,
      and(
        eq(operatorSide.conversationId, messageConversations.id),
        eq(operatorSide.humanId, subject.humanId),
      ),
    )
    .leftJoin(tasks, eq(tasks.id, messageConversations.taskId))
    .leftJoin(accountWishes, eq(accountWishes.id, messageConversations.wishId))
    .leftJoin(accounts, eq(accounts.id, messageConversations.accountId))
    .orderBy(asc(messageConversations.createdAt), asc(messageConversations.id))

  const stillLinked = await db
    .select({ agentId: humanAgents.agentId })
    .from(humanAgents)
    .where(and(eq(humanAgents.agentId, subject.agentId), eq(humanAgents.humanId, subject.humanId)))
    .limit(1)

  const closed = stillLinked.length === 0

  const threads: OperatorThreadForPage[] = []
  for (const row of rows) {
    const attached =
      sealingKey === undefined
        ? { shares: [], events: [] }
        : await sharesOnThread(db, row.id, sealingKey)

    threads.push({
      threadId: asConversationId(row.id),
      // `#1321`'s own phrase for a thread about nothing in particular. An
      // exchange always had a subject; a thread need not, and inventing one
      // would put a task title on a conversation that is not about it.
      context: row.context ?? 'something it did not name',
      openedAt: row.createdAt,
      messages: await messagesOfThread(db, row.id),
      closed,
      accountIdentifier: row.accountIdentifier,
      shares: attached.shares,
      shareEvents: attached.events,
    })
  }

  return threads
}

/** The words in one thread, oldest first, attributed by the party that wrote them. */
async function messagesOfThread(
  db: Database,
  conversation: string,
): Promise<readonly OperatorThreadMessage[]> {
  const rows = await db
    .select({
      party: messages.senderParty,
      body: messages.body,
      kind: messages.answerKind,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversation))
    .orderBy(asc(messages.createdAt), asc(messages.id))

  /**
   * **Three authors, since `#1445`.** `system-role` was folded into the
   * citizen's column, which was safe while every Colony message in an operator
   * thread was a notice *about* the citizen — nothing turned on the reader
   * telling them apart. A handoff does: its sentence is the Colony's, composed
   * from a recipe, and *no agent could have written it* is the whole reason a
   * person can act on it (`#592` constraint 4). A property nobody can see is
   * not a property, so it gets its own column and its own words on the page.
   *
   * What is unchanged is the rule underneath: neither is ever attributed to the
   * **operator**, which is `#236`'s side of the same distinction.
   */
  return rows.map((row) => ({
    author:
      row.party === 'operator-human'
        ? ('operator' as const)
        : row.party === 'system-role'
          ? ('colony' as const)
          : ('citizen' as const),
    body: row.body,
    kind: row.kind,
    writtenAt: row.createdAt,
  }))
}

/**
 * Which wishes have a question waiting on this person (`#1027`, `#1325`).
 *
 * **The join the schema already carries.** `message_conversations.wish_id` is
 * `operator_requests.wish_id`'s successor, mutually exclusive with `task_id` by
 * a check constraint — so a thread bound to a wish is a fact the database holds,
 * and the console's wish list is what turns the id back into a provider.
 *
 * **Waiting, not merely existing.** A thread the operator has answered is not
 * outstanding, which is the same condition the operator queue applies.
 */
export async function wishThreadsWaitingOn(
  db: Database,
  agentId: AgentId,
): Promise<readonly { readonly wishId: string; readonly threadId: ConversationId }[]> {
  const rows = await db
    .select({ id: messageConversations.id, wishId: messageConversations.wishId })
    .from(messageConversations)
    .innerJoin(
      messageParticipants,
      and(
        eq(messageParticipants.conversationId, messageConversations.id),
        eq(messageParticipants.agentId, agentId),
      ),
    )
    .where(
      and(
        sql`${messageConversations.wishId} is not null`,
        sql`not exists (
          select 1 from ${messages}
          where ${messages.conversationId} = ${messageConversations.id}
            and ${messages.senderParty} = 'operator-human'
        )`,
      ),
    )

  return rows.flatMap((row) =>
    row.wishId === null ? [] : [{ wishId: row.wishId, threadId: asConversationId(row.id) }],
  )
}

/** Where the page's write can land, and why it did not. */
export type PageAnswerOutcome =
  | {
      readonly outcome: 'answered'
      readonly agentId: AgentId
      readonly threadId: ConversationId
    }
  /**
   * One answer for every cause: the page was revoked, the token names no live
   * page, the citizen has several operators and none of them matched the
   * address, the id is not a thread this person is in, or the operator link has
   * since been removed. A page that distinguished them would be a probe.
   */
  | { readonly outcome: 'unreachable' }

/**
 * The operator answers into one thread, through the page it holds (`#1325`).
 *
 * **The token and the thread id are resolved together**, and that is the
 * property the page rests on. `answerOperatorRequest` resolved them in one query
 * so that a valid token could not be aimed at another citizen's exchange; the
 * same has to be true here, so a thread the page's own subject is not in is
 * `unreachable` rather than trusted because the form said so.
 *
 * **`sendOperatorMessage` does the writing**, so the page takes exactly the path
 * the console and the chat desk take: the same credential guard, the same
 * `answer_kind`, and the same clearing of a `needs-operator` set-aside (`#234`,
 * `#1319`). Nothing about answering from a bearer link is special except how the
 * person was identified.
 */
export async function answerOperatorThreadFromPage(
  db: Database,
  input: {
    readonly token: string
    readonly threadId: unknown
    readonly body: string
    readonly kind?: OperatorAnswerKind | undefined
  },
): Promise<PageAnswerOutcome> {
  if (typeof input.threadId !== 'string') return { outcome: 'unreachable' }

  const subject = await pageSubject(db, input.token)
  if (subject === undefined) return { outcome: 'unreachable' }

  const [mine] = await db
    .select({ id: messageParticipants.id })
    .from(messageParticipants)
    .where(
      and(
        eq(messageParticipants.conversationId, input.threadId),
        eq(messageParticipants.humanId, subject.humanId),
      ),
    )
    .limit(1)

  if (mine === undefined) return { outcome: 'unreachable' }

  const thread = asConversationId(input.threadId)
  const sent = await sendOperatorMessage(
    db,
    subject.humanId as HumanId,
    subject.agentId,
    // `null` where a control was pressed, so `sendOperatorMessage` resolves the
    // sentence from `OPERATOR_ANSWER_BODIES` itself and there is one place the
    // two halves of an answer can be made to agree.
    input.kind === undefined ? input.body : null,
    'your operator',
    input.kind,
    thread,
  )

  // Every storage refusal is `unreachable` here, including the one the page
  // cannot produce (`credential-shaped-body`): the API layer checks that before
  // it gets this far, so a refusal arriving here means the relationship ended
  // between the page loading and the press.
  return sent.outcome === 'delivered'
    ? { outcome: 'answered', agentId: subject.agentId, threadId: thread }
    : { outcome: 'unreachable' }
}

/**
 * Whether this citizen is waiting on its operator (`#1325`).
 *
 * Replaces `hasOpenOperatorRequest`, and the difference is what *open* means
 * once there is no exchange to close. An exchange was a row with a `closed_at`;
 * a thread is never finished, so the honest reading of the same question is
 * **the last word in an operator thread is the citizen's** — it asked and
 * nobody has answered since.
 *
 * That also fixes the thing the old shape got wrong for free: a citizen whose
 * operator had replied but who had not tidied up still counted as waiting, and
 * the digest went on offering it *ask your operator* as though it had.
 *
 * A boolean rather than the row, for the reason it always was: the caller wants
 * to know whether to say *you asked and it is still open*, and handing it the
 * text would put an operator's words on a surface nobody reviewed for them.
 */
export async function hasOpenOperatorThread(db: Database, agentId: AgentId): Promise<boolean> {
  const [row] = await db
    .select({ id: messageConversations.id })
    .from(messageConversations)
    .innerJoin(
      messageParticipants,
      and(
        eq(messageParticipants.conversationId, messageConversations.id),
        eq(messageParticipants.agentId, agentId),
      ),
    )
    .innerJoin(
      operatorSide,
      and(
        eq(operatorSide.conversationId, messageConversations.id),
        eq(operatorSide.party, 'operator-human'),
      ),
    )
    .where(
      sql`(
        select ${messages.senderParty}
        from ${messages}
        where ${messages.conversationId} = ${messageConversations.id}
        order by ${messages.createdAt} desc, ${messages.id} desc
        limit 1
      ) = 'citizen'`,
    )
    .limit(1)

  return row !== undefined
}

/**
 * Whether a person came back to this citizen about this task (`#1325`).
 *
 * Replaces `operatorAnsweredAbout`, unchanged in meaning: the thread is found by
 * the task it is about — which is what conversation provenance carries and what
 * made retiring the exchange possible at all — and the answer is whether the
 * operator has written into it.
 *
 * **Answered, not approved**, and closed history counts: a citizen that asked,
 * was answered and moved on has been answered.
 */
export async function operatorAnsweredAboutTask(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messageConversations)
    .innerJoin(
      messageParticipants,
      and(
        eq(messageParticipants.conversationId, messageConversations.id),
        eq(messageParticipants.agentId, agentId),
      ),
    )
    .innerJoin(messages, eq(messages.conversationId, messageConversations.id))
    .where(and(eq(messageConversations.taskId, taskId), eq(messages.senderParty, 'operator-human')))
    .limit(1)

  return row !== undefined
}

/**
 * Whether this citizen has already put this question to its operator (`#1325`).
 *
 * Replaces `operatorAskedAbout`. The exchange version excluded closed rows, so
 * that a citizen which had asked, been answered and closed could ask again; a
 * thread has no closed state, so what stands in for it is
 * {@link operatorAnsweredAboutTask} — the caller checks *answered* first and
 * only reaches this when nobody has replied. Asking twice into the same thread
 * is the thing this exists to prevent, and it still prevents it.
 */
export async function operatorAskedAboutTask(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<boolean> {
  const [row] = await db
    .select({ id: messageConversations.id })
    .from(messageConversations)
    .innerJoin(
      messageParticipants,
      and(
        eq(messageParticipants.conversationId, messageConversations.id),
        eq(messageParticipants.agentId, agentId),
      ),
    )
    .where(eq(messageConversations.taskId, taskId))
    .limit(1)

  return row !== undefined
}

/**
 * How many operator threads hold something the citizen has not read (`#1325`).
 *
 * Replaces `countWaitingOperatorReplies`, and this is the one place the move is
 * an upgrade rather than a translation. That function's own comment said the
 * question it asked — *is the last word the operator's* — was the honest one
 * **because there was no read marker on an exchange message**. There is one on a
 * message: `message_participants.last_read_message_id`, the same cursor
 * `listConversations` and the wake-up delta use.
 *
 * So the digest now counts what a person would call unread, the citizen's own
 * messages never count toward it, and `kolonie.messages.mark_read` is what
 * clears it — one deliberate act, as closing an exchange was.
 *
 * **A count and never the text.** An operator's words reach the citizen through
 * the thread, labelled as their own.
 */
export async function countWaitingOperatorReplies(db: Database, agentId: AgentId): Promise<number> {
  const cursor = alias(messages, 'operator_read_cursor')

  const rows = await db
    .selectDistinct({ conversationId: messages.conversationId })
    .from(messages)
    .innerJoin(
      messageParticipants,
      and(
        eq(messageParticipants.conversationId, messages.conversationId),
        eq(messageParticipants.agentId, agentId),
      ),
    )
    .leftJoin(cursor, eq(cursor.id, messageParticipants.lastReadMessageId))
    .where(
      and(
        eq(messages.senderParty, 'operator-human'),
        or(isNull(cursor.id), sql`${messages.createdAt} > ${cursor.createdAt}`),
      ),
    )

  return rows.length
}

/**
 * The shares hanging on one thread, opened, and what has happened to them.
 *
 * ## Why the events are derived rather than written
 *
 * `#1442` is explicit: **a share is not a message.** It must not be something
 * that can be sent, quoted or forwarded — it is state on the conversation, with
 * one lifecycle, visible to both parties. So there is no events table and no
 * system message: the four things that can happen to a share are four columns
 * on `vault_shares`, and this reads them into an order at render time. Nothing
 * can quote what was never written down as a message.
 *
 * **A taken-back share keeps its events and loses its value.** The sequence is
 * what makes the thread readable afterwards — *shared on Monday, opened
 * Tuesday, written into, handed back* — and it is exactly the account a person
 * returning to a finished thread wants. The value is gone either way, because
 * `unshare` and the sweep both clear it.
 */
async function sharesOnThread(
  db: Database,
  conversationId: string,
  sealingKey: string,
): Promise<{
  readonly shares: readonly OperatorThreadShare[]
  readonly events: readonly OperatorThreadShareEvent[]
}> {
  const rows = await db
    .select({
      id: vaultShares.id,
      agentId: vaultShares.agentId,
      vaultKey: vaultShares.vaultKey,
      purpose: vaultShares.purpose,
      sharedAt: vaultShares.sharedAt,
      expiresAt: vaultShares.expiresAt,
      sealedValue: vaultShares.sealedValue,
      sealedDescription: vaultShares.sealedDescription,
      operatorAddition: vaultShares.operatorAddition,
      additionWrittenAt: vaultShares.additionWrittenAt,
      lastReadAt: vaultShares.lastReadAt,
      takenBackAt: vaultShares.takenBackAt,
    })
    .from(messageConversationShares)
    .innerJoin(vaultShares, eq(vaultShares.id, messageConversationShares.shareId))
    .where(eq(messageConversationShares.conversationId, conversationId))
    .orderBy(asc(vaultShares.sharedAt), asc(vaultShares.id))

  const shares: OperatorThreadShare[] = []
  const events: OperatorThreadShareEvent[] = []

  for (const row of rows) {
    events.push({ vaultKey: row.vaultKey, kind: 'shared', at: row.sharedAt })
    if (row.lastReadAt !== null) {
      events.push({ vaultKey: row.vaultKey, kind: 'read', at: row.lastReadAt })
    }
    if (row.additionWrittenAt !== null) {
      events.push({ vaultKey: row.vaultKey, kind: 'written', at: row.additionWrittenAt })
    }
    if (row.takenBackAt !== null) {
      events.push({ vaultKey: row.vaultKey, kind: 'handed-back', at: row.takenBackAt })
    }

    /**
     * **A closed share is an event and not a box.** It has no value to render —
     * `unshare` and the sweep both clear it — and a box with nothing in it
     * beside a sentence about a credential is worse than the sequence alone.
     */
    if (row.takenBackAt !== null || row.sealedValue === null) continue
    if (Date.parse(row.expiresAt) <= Date.now()) continue

    const value = openVaultValue(
      sealingKey,
      row.agentId,
      `vault-share:${row.vaultKey}`,
      row.sealedValue,
    )
    if (value === null) continue

    shares.push({
      id: row.id,
      vaultKey: row.vaultKey,
      purpose: row.purpose,
      expiresAt: row.expiresAt,
      value,
      description:
        row.sealedDescription === null
          ? null
          : openVaultValue(
              sealingKey,
              row.agentId,
              vaultDescriptionScope(`vault-share:${row.vaultKey}`),
              row.sealedDescription,
            ),
      wrote: row.operatorAddition !== null,
    })
  }

  events.sort((left, right) => left.at.localeCompare(right.at))

  return { shares, events }
}
