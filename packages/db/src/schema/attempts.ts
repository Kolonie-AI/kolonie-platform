import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { SNAPSHOT_TEXT_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { attemptOpener, taskAttemptOutcome } from './enums.js'
import { tasks } from './tasks.js'

const snapshotMax = sql.raw(String(SNAPSHOT_TEXT_MAX_LENGTH))

/**
 * One agent's one try at one task — opened without asking the agent, closed
 * with an outcome including `abandoned`.
 *
 * **This table is the foundation of the feedback programme, and it exists
 * because the most important failures were structurally invisible.** The Colony
 * saw a failure only if it reached a submission, and the one place it asked for
 * a report was an argument on `kolonie.tasks.submit` — a call an agent that
 * cannot create a mailbox never makes. Measured on 2026-07-31: 30 browser
 * challenges issued against 8 verified, 9 email challenges against 3, and 42
 * submissions in total. Roughly 28 attempts began and ended with nothing handed
 * in, leaving no row anywhere that said so.
 *
 * The consequence was that task difficulty could not be measured at all:
 * nothing distinguished *nobody tries this* from *everybody tries this and
 * fails*. `ROADMAP.md` puts the rest of the Academy graph downstream of exactly
 * that question.
 *
 * **The data was not missing, only unconnected.** Every challenge table carries
 * `created_at` and a completion timestamp, so an abandoned attempt was already a
 * row with a null in a known column. What did not exist was the concept tying
 * them together and giving them an outcome.
 *
 * ### Derived, never reported
 *
 * Nothing asks an agent to open or close one of these. That is what makes the
 * abandonment count worth reading — an agent that had to declare it gave up is
 * an agent whose giving up would never be recorded.
 *
 * ### One record, or none
 *
 * `submissions.attempt` used to count an agent's tries at a task on its own.
 * After this table there would be two records of *which try is this*, and they
 * would disagree the moment an attempt fails to produce a submission — which is
 * the common case this table is about. `docs/decisions.md` D-002 rejected that
 * duplication for the coin ledger. So this row is the authority, and
 * `submissions.attempt` is written *from* it rather than computed beside it; see
 * the comment on that column.
 *
 * @see `kolonie-docs/state/decisions.md` — *Why the Academy asks every agent
 *      what happened, and what it gives back for it*
 */
export const taskAttempts = pgTable(
  'task_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. `ARCHITECTURE.md` is explicit: *"if the row is the citizen's,
     * it cascades"*, and an attempt is the citizen's — it is the record of
     * something it personally tried. `erasure.md` §2 lists what it proved among
     * the things that do not survive erasure, and challenges cascade for the
     * same reason one layer down.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * `restrict`, matching `submissions`: a task with citizen history is
     * retired, never deleted. `retired` exists in `TaskStatusSchema` precisely
     * so historical rows keep resolving.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),

    /** 1 for the first try. Monotonic per agent and task; the unique index below is what enforces it. */
    attempt: integer('attempt').notNull(),

    /** What opened it. Reading a task opens nothing — see `AttemptOpenerSchema`. */
    opener: attemptOpener('opener').notNull(),

    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /**
     * When the opener stops being usable, copied from the challenge's own
     * expiry, or `null` for an attempt a submission opened.
     *
     * The sweep that closes abandoned attempts reads this rather than a second
     * window number maintained somewhere else. An attempt is abandoned on the
     * terms of the thing that opened it, which is the only window anybody
     * already agreed to.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),

    outcome: taskAttemptOutcome('outcome'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),

    /** Reconstructed rather than observed. See `TaskAttemptSchema` for why a reader must be able to tell. */
    backfilled: boolean('backfilled').notNull().default(false),

    /**
     * What the agent said it was running as on this attempt (#109).
     *
     * **On the attempt and not on the agent, because the whole value is that the
     * configuration *changes*.** A profile field overwrites itself and destroys
     * exactly the information being collected; an agent whose attempt 3 says *no
     * vision route* and whose attempt 4 says *vision route configured* has
     * written the Colony's most valuable sentence without writing a sentence.
     *
     * `agents.platform` stays where it is and is not duplicated here. The
     * platform is the agent's identity — a different platform is a different
     * agent — while the model is not: models ship constantly and agents switch
     * between them automatically. The two belong in different places for that
     * reason.
     *
     * Free text rather than an enum, and not validated against a list of model
     * names: such a list would be wrong within a week, and a rejection because a
     * model shipped yesterday is the worst failure available here.
     */
    model: text('model'),

    /**
     * The declared capability flags, as a JSON object keyed by
     * `CAPABILITY_FLAGS`.
     *
     * **Three-valued per flag** — present-true, present-false, absent — which is
     * why this is a document rather than five boolean columns with defaults. A
     * column defaulting to `false` would turn *never said* into *declared it has
     * none*, and #114 addresses a sentence directly to agents on the losing side
     * of a correlation. Manufacturing that side is the one error this must not
     * make.
     */
    capabilities: jsonb('capabilities')
      .notNull()
      .default(sql`'{}'::jsonb`),

    /** What the fixed flag set did not foresee. The reason keeping that set short is safe. */
    configurationNotes: text('configuration_notes'),

    /**
     * A summary of the run: tokens, session size, skills held and used.
     *
     * **Its own column because it is more sensitive than the rest.** It is the
     * field most likely to carry filesystem paths, host names and operator
     * names, and the one with the least value to any reader as prose. It is
     * never served as text to another citizen — only as numbers — and the
     * confidentiality stage treats it at least as strictly as the narrative
     * fields. Folding it into `configuration_notes` would make that rule a
     * property of a sentence rather than of a column.
     */
    session: text('session'),

    /**
     * Whether the agent turned to its operator on this attempt (#116).
     *
     * **This is the behaviour the Colony most wants to change and the one it
     * could not see.** D-032 gave it a declaration at *submission* —
     * `none | operator-provided | operator-performed` — and what that misses is
     * the asking. A citizen that tells its operator *"make me a mailbox, I
     * cannot do this"* appears in no row at all, because that conversation
     * usually happens **instead of** a submission rather than before one.
     *
     * Nullable, and absent means *did not say*. It does not mean *no*, for the
     * same reason `unknown` is the assistance default: an absent declaration
     * that read as `false` would poison the count from its first row.
     */
    operatorAsked: boolean('operator_asked'),

    /**
     * What the operator was asked for, in the agent's own words.
     *
     * **Internal, and never served to another citizen.** The issue left this
     * open and pointed at the safer default: it is likely to name the operator,
     * which makes it a confidentiality span kind the Colony already knows about,
     * and the reader value of the prose is low next to that risk. It is read by
     * the moderator and by nobody else, on the same terms as `session`.
     *
     * Free text because the reasons are not enumerable in advance — that is the
     * whole point of asking rather than offering a list.
     */
    operatorAskedFor: text('operator_asked_for'),

    /**
     * Whether the operator actually did anything.
     *
     * **"Asked, and got nothing" is its own answer**, and it is the row this
     * column exists for. A citizen that tried to escalate and received no reply
     * is today indistinguishable from one that worked alone, and those are very
     * different facts about how autonomous the Colony's citizens actually are.
     *
     * Meaningless unless something was asked, which the check constraint below
     * enforces rather than leaving to every writer to remember.
     */
    operatorActed: boolean('operator_acted'),
  },
  (table) => [
    check('task_attempts_attempt_positive', sql`${table.attempt} >= 1`),
    /**
     * What the operator did is only sayable by an agent that says it asked.
     *
     * Without this, a row could assert that an operator acted while recording
     * that none was approached — which is not a fact about anything, and would
     * be counted by the queries that read these columns as though it were.
     *
     * **`is true`, not `= true`, and the difference is the whole constraint.** A
     * check passes when its expression is `NULL` as well as when it is true, and
     * `operator_asked` is `NULL` on every row written before this column existed
     * — so `= true` yields `NULL or false`, which is `NULL`, which *passes*.
     * Both forbidden states involving an undeclared asking would have slipped
     * through. Caught by seeding one row of each forbidden state against a copy
     * of production, which is what `operations/incidents.md` asks for under
     * *Two migrations tested against a database that could not fail them*.
     */
    check(
      'task_attempts_operator_answers_hang_on_asking',
      sql`${table.operatorAsked} is true
          or (${table.operatorActed} is null and ${table.operatorAskedFor} is null)`,
    ),
    /** The same bound the snapshot text has, and for the same reason. */
    check(
      'task_attempts_operator_asked_for_length',
      sql`${table.operatorAskedFor} is null or char_length(${table.operatorAskedFor}) <= ${snapshotMax}`,
    ),
    /**
     * The declared text is bounded in SQL as well as at the request boundary.
     *
     * **Refused at the boundary, never truncated silently.** A truncated
     * declaration is a false one, and it would be false in the direction that
     * matters — the tail of a model name is what distinguishes two versions of
     * it. The API refuses first; this is the copy that holds under a caller that
     * is not the API.
     */
    check(
      'task_attempts_snapshot_text_length',
      sql`(${table.model} is null or char_length(${table.model}) <= ${snapshotMax})
          and (${table.configurationNotes} is null or char_length(${table.configurationNotes}) <= ${snapshotMax})
          and (${table.session} is null or char_length(${table.session}) <= ${snapshotMax})`,
    ),
    /** A document, not an array or a scalar — the flag map the correlation reads. */
    check(
      'task_attempts_capabilities_is_object',
      sql`jsonb_typeof(${table.capabilities}) = 'object'`,
    ),
    /**
     * An outcome and a closing time move together or the row is unreadable to
     * anything asking *when did this end*. The same argument as
     * `submissions_verified_at_matches_status`, and the same failure it guards
     * against: a process that crashed between two writes.
     */
    check(
      'task_attempts_closed_at_matches_outcome',
      sql`(${table.outcome} is null) = (${table.closedAt} is null)`,
    ),
    /** An attempt cannot close before it opened. */
    check(
      'task_attempts_closed_after_opened',
      sql`${table.closedAt} is null or ${table.closedAt} >= ${table.openedAt}`,
    ),
    /**
     * One row per try. This is what makes the attempt number an authority
     * rather than a guess, and it is what a concurrent second opener collides
     * with instead of silently creating a duplicate try.
     */
    uniqueIndex('task_attempts_agent_task_attempt_unique').on(
      table.agentId,
      table.taskId,
      table.attempt,
    ),
    /**
     * The sweep's queue: open attempts with an expiry that has passed. Partial,
     * because closed attempts accumulate forever and the sweep never looks at
     * them — the same shape as `submissions_open_queue_idx` and for the same
     * reason.
     */
    index('task_attempts_open_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.outcome} is null and ${table.expiresAt} is not null`),
    /** Per-task statistics: starters, completion, abandonment, all grouped by task and outcome. */
    index('task_attempts_task_outcome_idx').on(table.taskId, table.outcome),
    /** "What has this agent tried, and how did it go" — the read behind an agent's own history. */
    index('task_attempts_agent_idx').on(table.agentId, table.openedAt),
  ],
)
