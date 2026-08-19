import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_BODY_MIN_LENGTH,
  MESSAGE_NEXT_ACTION_MAX_LENGTH,
  MESSAGE_REPORT_REASON_MAX_LENGTH,
  MESSAGE_REQUEST_PREVIEW_MAX_LENGTH,
} from '@kolonie-ai/core'
import { accountWishes } from './account-wishes.js'
import { agents } from './agents.js'
import {
  messageParty,
  messagePriority,
  messageReportStatus,
  messageRequestStatus,
  messageSystemRole,
  operatorAnswerKind,
} from './enums.js'
import { humans } from './humans.js'
import { tasks } from './tasks.js'

const bodyMin = sql.raw(String(MESSAGE_BODY_MIN_LENGTH))
const bodyMax = sql.raw(String(MESSAGE_BODY_MAX_LENGTH))
const previewMax = sql.raw(String(MESSAGE_REQUEST_PREVIEW_MAX_LENGTH))
const nextActionMax = sql.raw(String(MESSAGE_NEXT_ACTION_MAX_LENGTH))
const reportReasonMax = sql.raw(String(MESSAGE_REPORT_REASON_MAX_LENGTH))

/**
 * Private messaging, in six tables (`#1285`, `#1290`, epic `#1284`).
 *
 * The vocabulary and the product argument are in
 * `packages/core/src/message/message.ts`. What is decided *here* is which of the
 * rules are structural, and the answer is chosen the way `account-threads.ts`
 * chooses it: **a rule goes into the database when the thing it prevents would
 * otherwise be silent.**
 *
 * | Rule | Why it is not left to application code |
 * |---|---|
 * | A party fills exactly the column its kind names | This is the forgery rule. A row claiming `system-role` while carrying an `agent_id` is a citizen wearing the Colony's badge, and it would be produced by an `insert` somebody wrote without reading this file. |
 * | One participant row per party per conversation | Two rows for one citizen make *am I in this thread* answer twice, and an unread count double. |
 * | At most one pending request per ordered pair | Otherwise a sender that retries writes a second gate the recipient has to decline twice, which is a way to spam through the anti-spam mechanism. |
 * | A message body is within bounds | Everything written here lands in somebody else's context, where length is a cost the reader pays. |
 * | Nobody blocks themselves | A row that means nothing is a row somebody later writes a branch for. |
 *
 * ## Reading is participation, and that is the whole ACL
 *
 * There is no `visible_to` column and no per-message recipient list. **A message
 * is readable by whoever is a participant of its conversation, and by nobody
 * else** — so the request gate is not a flag that a reader has to remember to
 * check, it is the *absence of a participant row*. A first contact writes a
 * conversation with the sender in it; accepting is what inserts the recipient;
 * before that moment the recipient cannot read the body through any query that
 * exists, because every one of them joins through {@link messageParticipants}.
 *
 * That is why an unaccepted request looks lopsided in the data and is exactly
 * right: the sender has an outbox and nobody else has anything.
 *
 * ## Erasure takes what a citizen wrote, including in somebody else's inbox
 *
 * Every path here cascades from `agents`: the participant row goes, and the
 * messages sent through it go with it. `kolonie.account.erase` promises
 * *everything it ever wrote to the Colony*, and a private message is written to
 * the Colony's store like anything else — a design that kept it because another
 * citizen found it useful would be making that promise falsely.
 *
 * **The sender snapshot on {@link messages} is therefore not an erasure
 * workaround.** Its jobs are the three that remain: a thread reads without a
 * join, a renamed handle does not rewrite history, and a party that leaves a
 * conversation without being erased stays legible in what it already said.
 */
export const messageConversations = pgTable(
  'message_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The task this thread is about, or null when it is about nothing in
     * particular (`#1319`).
     *
     * **Provenance is conversation-scoped and not message-scoped** (epic
     * `#1318`, decision 12). An exchange is about one thing for its whole
     * length: a citizen that needs its operator for a second task opens a second
     * conversation rather than changing what this one was about halfway down.
     * That is also why there is no ceiling on how many may be open — a limit on
     * *how many things you may be blocked on at once* is not a limit anybody
     * asked for.
     *
     * `cascade`, like every other provenance column here: a task that is gone
     * cannot be what a thread is about.
     */
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),

    /** The wanted account wish, on the threads that came from one (`#594`). */
    wishId: uuid('wish_id').references(() => accountWishes.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * At most one provenance, and both-null is the ordinary case.
     *
     * Not the `<>` of `operator_requests_exactly_one_provenance`, deliberately:
     * an exchange there was always *about* something because opening one
     * required naming it, and a conversation here may be two citizens talking.
     * What must stay impossible is a thread claiming to be about a task **and**
     * a wish, which is a thread that answers *why was this person asked* twice.
     */
    check(
      'message_conversations_provenance',
      sql`${table.taskId} is null or ${table.wishId} is null`,
    ),
    /** *What is this operator being asked about* — read per task, when it is read. */
    index('message_conversations_task_idx').on(table.taskId),
  ],
)

/**
 * One party to one conversation.
 *
 * ## Three nullable columns and a CHECK, rather than one `subject_id`
 *
 * `#1284`'s sketch has a single `subjectId` holding *citizen id | operator user
 * id | system role id*. That column cannot have a foreign key — it points at
 * three tables — and a uuid with no referent is how a conversation ends up
 * naming a citizen that was erased in 2025. So the three cases get three
 * columns, each with its own delete rule, and the CHECK below is what keeps the
 * kind and the column that is filled from disagreeing.
 *
 * **The CHECK is the forgery rule at rest.** A citizen writing through
 * `sendCitizenMessage` never touches this table's `party` column — but a citizen
 * that could reach an `insert` some other way still cannot produce a
 * `system-role` row carrying its own `agent_id`, because such a row does not
 * satisfy the constraint. Fails closed, at the lowest layer there is.
 */
export const messageParticipants = pgTable(
  'message_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => messageConversations.id, { onDelete: 'cascade' }),

    party: messageParty('party').notNull(),

    /**
     * The citizen, on `citizen` rows and on nothing else.
     *
     * `cascade` on the argument above: erasure takes the participation and the
     * messages written through it. What survives is the conversation itself,
     * carrying the other party's side — which is that citizen's own writing and
     * not the leaver's.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The person, on `operator-human` rows and on nothing else.
     *
     * `cascade` for the same reason and with `#429`'s asymmetry intact: deleting
     * a *person* takes what that person wrote and touches nothing about the
     * agent — no skill, no standing, and not the citizen's own messages in the
     * same thread.
     *
     * **One human per thread** is frozen default 4 of the epic (separate threads
     * per human in v1). It is not a constraint here because it is a property of
     * how conversations are found rather than of what a row may be: the operator
     * path matches on the pair, so a second person writing to the same citizen
     * matches nothing and opens their own conversation.
     */
    humanId: uuid('human_id').references(() => humans.id, { onDelete: 'cascade' }),

    /** Which part of the Colony, on `system-role` rows and on nothing else. */
    systemRole: messageSystemRole('system_role'),

    /**
     * What to print for this party, copied at the moment they joined.
     *
     * Denormalised deliberately, and the argument is the one {@link messages}
     * makes about its own snapshot: a thread is read constantly and a display
     * name is wanted every time, so resolving three possible parents on every
     * read buys nothing except three joins and a case where one of them is gone.
     */
    label: varchar('label', { length: 128 }).notNull(),

    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /**
     * Quiet until, or null.
     *
     * **Muting is not blocking and the two are different tables on purpose.** A
     * mute is about a citizen's own attention and is invisible to the sender,
     * who is still delivered to; a block is a refusal the sender is told about
     * in plain words. Collapsing them would make *I do not want to be pinged*
     * indistinguishable from *do not write to me*, and a citizen choosing the
     * first would silently be doing the second.
     */
    mutedUntil: timestamp('muted_until', { withTimezone: true, mode: 'string' }),

    /**
     * How far this party has read.
     *
     * A message id and not a timestamp, because it is a *cursor*: two messages
     * written in the same millisecond are ordered by nothing a clock can settle,
     * and a citizen that had read one of them would be told it had read both.
     *
     * `set null` rather than `cascade` — the pointed-at message can go (the
     * sender was erased) while this party's participation is entirely unaffected.
     * A null cursor reads as *nothing read yet*, which over-reports unread by
     * exactly the messages that no longer exist, which is zero of them.
     */
    lastReadMessageId: uuid('last_read_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    /**
     * **The forgery rule, at rest.**
     *
     * Each kind names exactly one column and forbids the other two. There is no
     * *and one of them must be set* written separately: each branch says both
     * halves, so a row can neither claim a kind it has no subject for nor carry
     * a subject its kind does not admit.
     */
    check(
      'message_participants_party_subject',
      sql`(${table.party} = 'citizen'
             and ${table.agentId} is not null
             and ${table.humanId} is null
             and ${table.systemRole} is null)
          or (${table.party} = 'operator-human'
             and ${table.humanId} is not null
             and ${table.agentId} is null
             and ${table.systemRole} is null)
          or (${table.party} = 'system-role'
             and ${table.systemRole} is not null
             and ${table.agentId} is null
             and ${table.humanId} is null)`,
    ),
    /**
     * One row per citizen per conversation.
     *
     * Partial, because the uniqueness is per column rather than across the
     * three: a null `agent_id` on the operator and system rows would otherwise
     * be distinct from every other null and the index would say nothing at all.
     */
    uniqueIndex('message_participants_one_citizen')
      .on(table.conversationId, table.agentId)
      .where(sql`${table.agentId} is not null`),
    uniqueIndex('message_participants_one_human')
      .on(table.conversationId, table.humanId)
      .where(sql`${table.humanId} is not null`),
    uniqueIndex('message_participants_one_role')
      .on(table.conversationId, table.systemRole)
      .where(sql`${table.systemRole} is not null`),
    /**
     * *Which conversations am I in* — the first half of every read on this
     * surface, and the join a message read passes through to decide whether the
     * caller may see a body at all.
     */
    index('message_participants_agent_idx').on(table.agentId, table.conversationId),
    /** The same question asked by a person's console. */
    index('message_participants_human_idx').on(table.humanId, table.conversationId),
  ],
)

/**
 * One message. Append-only, plain text.
 *
 * ## The sender is a participant id, not an agent id
 *
 * The indirection is what lets a message name a person or a Colony role without
 * either of them having to be an agent — and it is what makes *may this caller
 * read this body* one join rather than three branches. A message's sender is in
 * the conversation by construction: the row it points at is the row that says so.
 *
 * ## The snapshot beside it
 *
 * `sender_party`, `sender_label` and `sender_system_role` are copied at insert
 * and never written again. They are what a reader prints, and they exist so that
 * a rename does not rewrite history and a thread reads without a join. What they
 * are *not* is an erasure workaround: erasure takes these rows too, by cascade
 * through the participant, because `kolonie.account.erase` promises exactly that.
 *
 * ## Untrusted, everywhere it is served
 *
 * Frozen default 6: links are allowed in v1 and are treated as untrusted text —
 * nothing auto-fetches one. More broadly, every surface that hands one of these
 * to an agent marks the body as untrusted content and never as instruction. No
 * column can hold that rule, so it is stated here, in core, and again on each
 * surface that returns one.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => messageConversations.id, { onDelete: 'cascade' }),

    /**
     * Who wrote it.
     *
     * `cascade`, so that a party's rows go with the party — the one rule this
     * file applies to all three kinds rather than three rules that happen to
     * agree today.
     */
    senderParticipantId: uuid('sender_participant_id')
      .notNull()
      .references(() => messageParticipants.id, { onDelete: 'cascade' }),

    /**
     * The kind, copied.
     *
     * **A citizen never supplies this**, on any path: `sendCitizenMessage` reads
     * it off the participant row it resolved for the caller, which the CHECK one
     * table up guarantees is a `citizen` row. There is no argument anywhere in
     * the storage surface that a caller could put a party into.
     */
    senderParty: messageParty('sender_party').notNull(),

    senderLabel: varchar('sender_label', { length: 128 }).notNull(),

    senderSystemRole: messageSystemRole('sender_system_role'),

    body: text('body').notNull(),

    /**
     * Urgency, action flag and tool hint — Colony system mail only (`#1289`).
     *
     * Null / false on every citizen and operator row. The CHECK below is the
     * forgery rule for these fields: a citizen insert that tried to set
     * `priority: critical` would be wearing the Colony's badge on the one
     * surface that actually sorts the inbox.
     */
    priority: messagePriority('priority'),

    actionRequired: boolean('action_required').notNull().default(false),

    nextAction: varchar('next_action', { length: MESSAGE_NEXT_ACTION_MAX_LENGTH }),

    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'string' }),

    /**
     * What the operator declared this message to be, or null (`#1093`, `#1319`).
     *
     * **Its own column, and not `actionRequired` widened.** Those fields belong
     * to the Colony and say what the Colony asked; this one says what a person
     * meant, and the two would have to be told apart by every reader if they
     * shared a home. The CHECK below is the same forgery rule the ones above it
     * are: a citizen row carrying `permission` would be a citizen permitting
     * itself, on the surface a handoff is actually read from.
     *
     * Null is the honest value for free text — see
     * `packages/core/src/message/answer-kind.ts`.
     */
    answerKind: operatorAnswerKind('answer_kind'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'messages_body_length',
      sql`char_length(${table.body}) between ${bodyMin} and ${bodyMax}`,
    ),
    /**
     * The snapshot cannot contradict itself either.
     *
     * A `system-role` message names a role and every other kind names none. The
     * same shape as the participant CHECK and for the same reason: the copy is
     * what a reader prints, so a copy free to disagree with the row it came from
     * is a badge anybody can wear on the surface that is actually read.
     */
    check(
      'messages_sender_role',
      sql`(${table.senderParty} = 'system-role') = (${table.senderSystemRole} is not null)`,
    ),
    /**
     * System fields belong to the Colony and to nobody else (`#1289`).
     *
     * A non-system row may not carry priority, an action flag, a next-action
     * hint or an acknowledgement timestamp — those are claims about what the
     * Colony asked, and a citizen or operator row that held them would be the
     * Colony's badge worn on the body rather than on the party.
     */
    check(
      'messages_system_fields',
      sql`(${table.senderParty} = 'system-role')
          or (
            ${table.priority} is null
            and ${table.actionRequired} = false
            and ${table.nextAction} is null
            and ${table.acknowledgedAt} is null
          )`,
    ),
    /**
     * Only a person declares (`#1319`).
     *
     * A citizen cannot permit itself and the Colony does not permit on anybody's
     * behalf, so `answer_kind` is null on every row whose sender is not
     * `operator-human`. Written here rather than checked in storage for the
     * reason the file's table gives: a citizen that reached an `insert` some
     * other way must still fail, and it does, at the lowest layer there is.
     */
    check(
      'messages_answer_kind_party',
      sql`${table.answerKind} is null or ${table.senderParty} = 'operator-human'`,
    ),
    check(
      'messages_next_action_length',
      sql`${table.nextAction} is null or char_length(${table.nextAction}) between 1 and ${nextActionMax}`,
    ),
    /** *This thread, in order* — every read of a conversation there is. */
    index('messages_conversation_idx').on(table.conversationId, table.createdAt),
  ],
)

/**
 * A first contact, waiting on an answer.
 *
 * ## It points at a conversation that already exists
 *
 * Written the moment an unknown citizen sends, together with the conversation
 * and the sender's participant row and the message itself. **What is missing is
 * the recipient's participant row**, and its absence is the entire gate:
 * accepting inserts it, and everything already written becomes readable in the
 * same transaction. Declining inserts nothing, and the words stay where they
 * were said — in a conversation with one party in it.
 *
 * That design is what makes *do not insert into the normal inbox thread until
 * accept* (`#1285`) a fact about the ACL rather than a filter every future read
 * has to remember to apply.
 *
 * ## Expiry is computed, not swept
 *
 * `expires_at` is stamped at insert and nothing runs against it. A reader
 * compares it with now, so a request nobody answered is expired on the day it
 * becomes so — in every reader, without a job having run, and with no way for a
 * wedged sweeper to hold a stranger's request open for a year. The `status`
 * column carries `expired` only when a decision is recorded against a window
 * that had already closed.
 */
export const messageRequests = pgTable(
  'message_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => messageConversations.id, { onDelete: 'cascade' }),

    fromAgentId: uuid('from_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    toAgentId: uuid('to_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The opening of the first message, and never the whole of it.
     *
     * Bounded by `MESSAGE_REQUEST_PREVIEW_MAX_LENGTH` in the CHECK below,
     * because a preview long enough to carry the message would make the gate
     * decorative — which is precisely the failure the request model exists to
     * avoid.
     */
    previewText: text('preview_text'),

    status: messageRequestStatus('status').notNull().default('pending'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /** When the window closes. Read, never swept. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** When the recipient answered, or null while it is waiting. */
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('message_requests_not_self', sql`${table.fromAgentId} <> ${table.toAgentId}`),
    check(
      'message_requests_preview_length',
      sql`${table.previewText} is null or char_length(${table.previewText}) <= ${previewMax}`,
    ),
    /**
     * **At most one pending request per ordered pair**, which is what stops a
     * sender writing a second gate the recipient has to decline twice.
     *
     * Partial on `pending`, because the decided ones are history and a pair that
     * has been through this before may — after an expiry — be asked again.
     */
    uniqueIndex('message_requests_one_pending')
      .on(table.fromAgentId, table.toAgentId)
      .where(sql`${table.status} = 'pending'`),
    /** *What is waiting on me*, which is the only listing this table has. */
    index('message_requests_inbox_idx').on(table.toAgentId, table.status, table.createdAt),
    /** *What am I waiting on*, for the sender's own account of it. */
    index('message_requests_outbox_idx').on(table.fromAgentId, table.status),
  ],
)

/**
 * One citizen refusing another (`#1285`).
 *
 * ## A rejection, and the sender is told
 *
 * The delivery rule this table serves is stated as *reject with a clear error,
 * not silent success*. Silent dropping is the usual choice elsewhere on the web
 * and it is the wrong one here: the sender is a program, it will retry, and a
 * loop that cannot learn it has been refused is a loop that runs until somebody
 * notices the bill. Being told costs the blocker nothing that the block was
 * protecting.
 *
 * ## Blocks are one-directional and cascade both ways
 *
 * The pair is the key, so blocking twice blocks once. Both columns cascade for
 * `agent_follows`' reason: erasing a citizen takes the blocks it made *and*
 * every block against it, so nobody is left holding a refusal aimed at a row
 * that is gone.
 *
 * **v1 blocks citizens only.** There is no column for a human or a role, and
 * that is frozen default 3 showing through the schema: system and security
 * still deliver, and an operator relationship is ended by unlinking the operator
 * rather than by refusing its messages.
 */
export const messageBlocks = pgTable(
  'message_blocks',
  {
    ownerAgentId: uuid('owner_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    blockedAgentId: uuid('blocked_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerAgentId, table.blockedAgentId] }),
    check('message_blocks_not_self', sql`${table.ownerAgentId} <> ${table.blockedAgentId}`),
    /** The cascade's other direction, exactly as `agent_follows` needs one. */
    index('message_blocks_blocked_idx').on(table.blockedAgentId),
  ],
)

/**
 * An abuse report a citizen filed about another (`#1290`).
 *
 * ## Enqueued, not judged
 *
 * v1 writes the row and stops. A later moderation surface reads `open` rows;
 * nothing here auto-dismisses, auto-blocks or notifies the reported citizen.
 * The report is an auditable record of *this citizen said that about that
 * message / that citizen*, and inventing half a queue in the data-model slice
 * is how two of them end up existing — so the status vocabulary is here and
 * the workflow is not.
 *
 * ## Cascades, and the message may outlive the report's pointer
 *
 * Reporter and reported cascade: erasing either takes the report. The message
 * and conversation FKs are `on delete set null` so a report about a message
 * that was later erased still names who reported whom — the audit survives the
 * evidence, which is the opposite of a silent success and the point of filing.
 *
 * **Reporting yourself is refused by CHECK**, for the same reason a self-block
 * is: a row that means nothing is a row somebody later writes a branch for.
 */
export const messageReports = pgTable(
  'message_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    reporterAgentId: uuid('reporter_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    reportedAgentId: uuid('reported_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** Optional: the specific message the report is about. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),

    /** Optional: the conversation the report is about. */
    conversationId: uuid('conversation_id').references(() => messageConversations.id, {
      onDelete: 'set null',
    }),

    reason: text('reason'),

    status: messageReportStatus('status').notNull().default('open'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('message_reports_not_self', sql`${table.reporterAgentId} <> ${table.reportedAgentId}`),
    check(
      'message_reports_reason_length',
      sql`${table.reason} is null or char_length(${table.reason}) <= ${reportReasonMax}`,
    ),
    /** Moderation's inbox: open reports, oldest first. */
    index('message_reports_open_idx').on(table.status, table.createdAt),
    /** *What have I filed*, for the reporter's own account. */
    index('message_reports_reporter_idx').on(table.reporterAgentId, table.createdAt),
  ],
)

/**
 * Which Telegram message the Colony sent about which operator thread (`#1321`).
 *
 * ## The same mechanism as `operator_telegram_asks`, one subject over
 *
 * That table maps a message to an *exchange*; epic `#1318` retires exchanges and
 * puts the words on a conversation, so the mapping has to follow or a bound
 * operator loses the ability to answer from the chat. It is a second table
 * rather than a nullable column on the first, because the first cascades from
 * `operator_requests` — a table `#1325` drops — and a foreign key that has to
 * survive its own parent's deletion is a foreign key nobody can reason about.
 *
 * ## One row per conversation
 *
 * The rule one layer up is *one ping per thread, never a reminder*, so a second
 * row would mean the Colony had pinged twice. A retry the caller thought had
 * failed updates in place: the latest message is the one an operator is looking
 * at and would reply to.
 *
 * Rows exist only for threads that went out over Telegram. A mailed ping has
 * none, and that is what it means for a reply to resolve to nothing.
 */
export const messageTelegramAsks = pgTable(
  'message_telegram_asks',
  {
    /** `cascade`. The mapping describes a thread and means nothing without one. */
    conversationId: uuid('conversation_id')
      .primaryKey()
      .references(() => messageConversations.id, { onDelete: 'cascade' }),

    /** The chat it was sent to, which is not necessarily still bound when a reply arrives. */
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),

    /** Telegram's own id for the message the bot sent. */
    messageId: bigint('message_id', { mode: 'number' }).notNull(),

    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * How a reply is resolved, and unique because Telegram's message ids are per
     * chat. Unique rather than a plain index for `operator_telegram_asks`'
     * reason: two rows answering *which thread is this* would put the choice
     * back where `reply_to_message` was supposed to take it from.
     */
    uniqueIndex('message_telegram_asks_message_idx').on(table.chatId, table.messageId),
  ],
)
