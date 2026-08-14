import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  ENTRY_BODY_MAX_LENGTH,
  EPISODE_TITLE_MAX_LENGTH,
  EPISODE_WALL_MAX_LENGTH,
  SLOT_LABEL_MAX_LENGTH,
  SLOT_VALUE_MAX_LENGTH,
} from '@kolonie-ai/core'
import { accounts } from './accounts.js'
import { episodeKind, episodeOutcome, episodeTurn, slotFiller, threadParty } from './enums.js'

/**
 * The conversation that hangs off an account (`#929`).
 *
 * The vocabulary and the argument are in `packages/core/src/account/thread.ts`
 * and in `kolonie-docs/state/decisions/the-account-is-the-permanent-object.md`.
 * What is decided *here* is which of the rules are structural, and the answer is
 * chosen the same way each time: **a rule goes into the database when the thing
 * it prevents would otherwise be silent.**
 *
 * Four of them are:
 *
 * | Rule | Why it is not left to application code |
 * |---|---|
 * | Every account has a thread | A trigger, not a call site. Two paths already insert accounts and a third will; each one that had to remember is a chance to forget, and an account whose thread is missing looks exactly like an account nothing has happened to. |
 * | One `acquisition` per thread, ever | The Atlas draft is derived from that episode *alone*. A second one changes what the Colony publishes about a provider, and it changes it quietly. |
 * | `failed` carries a wall | A failure with no wall is the row that made the whole design worth doing and then said nothing about why. |
 * | A closed episode rests at `nobody` | *Closed* and *waiting on you* are contradictory states, and a console reading the second would tell an operator to act on something finished. |
 *
 * One deliberately is **not**: entries are refused an `UPDATE` by trigger and
 * are *not* refused a `DELETE`. Erasure takes everything an agent ever wrote —
 * that is what erasure means — and it reaches these rows by cascade, so a
 * trigger that refused deletes would refuse erasure. Append-only is therefore
 * held two ways: the database refuses to change a body, and the storage surface
 * exposes no path that removes one.
 */
export const accountThreads = pgTable('account_threads', {
  id: uuid('id').primaryKey().defaultRandom(),

  /**
   * One thread per account, and the `unique` is what says *one*.
   *
   * `cascade` for the same reason the account itself cascades from the agent:
   * `erasure.md` §2 lists what a citizen proved among the things that do not
   * survive erasure, and everything ever said about how it got there is part
   * of that.
   */
  accountId: uuid('account_id')
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: 'cascade' }),

  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
})

/**
 * One stretch of work about the account.
 *
 * **The row that opens and closes.** The thread never does, which is why it has
 * no columns beyond its own identity: an account that needs attention a second
 * time gets a second episode rather than a reopened first one, and the record of
 * how it was obtained stays exactly as it was.
 */
export const accountEpisodes = pgTable(
  'account_episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    threadId: uuid('thread_id')
      .notNull()
      .references(() => accountThreads.id, { onDelete: 'cascade' }),

    /**
     * Who opened it — including `colony`, which is not decoration.
     *
     * A re-check that fails opens an episode with neither party having acted
     * (`#934`). An opener column that could only name an agent or an operator
     * would force a small lie at exactly the moment the account is in trouble.
     */
    openedBy: threadParty('opened_by').notNull(),

    kind: episodeKind('kind').notNull(),

    /**
     * Whose move it is, resting at `nobody`.
     *
     * **Not permission to speak.** Either side may write an entry whatever this
     * says; the turn is who owes the other something, and an operator realising
     * two hours later that the address was wrong must be able to say so without
     * seizing it.
     */
    turn: episodeTurn('turn').notNull().default('nobody'),

    /** One line, for a console listing episodes. The account of it is the entries. */
    title: text('title').notNull(),

    /** Null while it is open. Setting it is what closing means. */
    outcome: episodeOutcome('outcome'),

    /** What stopped it. Required by `failed` and refused by everything else. */
    wall: text('wall'),

    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /**
     * Stamped by the same trigger that enforces the resting turn, never by a
     * caller — the pattern `tasks_stamp_retirement` established in `0105`. A date
     * a caller supplies is a date that can disagree with the state beside it.
     */
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * **At most one acquisition per thread, ever** — the criterion `#929` asks
     * for at the database level rather than only in application code.
     *
     * Partial, because `maintenance` is unbounded by design: an account may need
     * repairing any number of times, and the episode that brought it into being
     * happened exactly once. A row deleted and rewritten would still be one; the
     * index is on the fact, not on the attempt.
     */
    uniqueIndex('account_episodes_one_acquisition')
      .on(table.threadId)
      .where(sql`${table.kind} = 'acquisition'`),

    /**
     * A failure says what it failed at.
     *
     * The wall is what the next citizen reads and what the Atlas learns from, so
     * a `failed` row without one is the row that cost somebody a day and then
     * recorded nothing. `outcomeNeedsWall` in core is the readable half of this
     * rule; this is the half that cannot be forgotten.
     */
    check(
      'account_episodes_failed_has_a_wall',
      sql`${table.outcome} is distinct from 'failed' or ${table.wall} is not null`,
    ),

    /**
     * And nothing else carries one. A wall on an open episode would be a failure
     * asserted about something still running, and a wall beside `created` would
     * be a contradiction a reader has to resolve.
     */
    check(
      'account_episodes_wall_belongs_to_a_failure',
      sql`${table.wall} is null or ${table.outcome} = 'failed'`,
    ),

    /**
     * **A closed episode rests.** *Finished* and *waiting on the operator* cannot
     * both be true, and a console that read the second would ask a person to act
     * on something that ended last month.
     *
     * This is also what makes the rejection case structural: passing the turn on
     * a closed episode is refused by `passTurn`, and refused again here if some
     * later caller writes the update itself.
     */
    check(
      'account_episodes_closed_rests',
      sql`${table.outcome} is null or ${table.turn} = 'nobody'`,
    ),

    /** Closed and dated are one fact, so they are written and read as one. */
    check(
      'account_episodes_closed_has_a_date',
      sql`(${table.outcome} is null) = (${table.closedAt} is null)`,
    ),

    check(
      'account_episodes_title_fits',
      sql`length(${table.title}) between 1 and ${sql.raw(String(EPISODE_TITLE_MAX_LENGTH))}`,
    ),

    check(
      'account_episodes_wall_fits',
      sql`${table.wall} is null or length(${table.wall}) between 1 and ${sql.raw(String(EPISODE_WALL_MAX_LENGTH))}`,
    ),

    /** *This account's episodes, newest first* — the one read the console makes. */
    index('account_episodes_thread_idx').on(table.threadId, table.openedAt),

    /**
     * *What is waiting on somebody* — across every account of one agent, which is
     * the question `#930`'s tool answers and the only one that scans this table
     * without a thread in hand.
     */
    index('account_episodes_open_idx')
      .on(table.turn)
      .where(sql`${table.outcome} is null`),
  ],
)

/**
 * A labelled container for one thing that has to change hands.
 *
 * **The value arrives sealed or not sealed according to who filled it, and this
 * table does neither.** `#929` introduces no cryptography: an operator's secret
 * is sealed for the agent's vault by the path that already does that, an agent's
 * is a console-readable seal by the path that already does that, and both hand
 * the result here. A third mechanism would be a third thing to get right.
 */
export const accountSlots = pgTable(
  'account_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    episodeId: uuid('episode_id')
      .notNull()
      .references(() => accountEpisodes.id, { onDelete: 'cascade' }),

    /**
     * Free text, and the alternative was considered and refused.
     *
     * A closed vocabulary of *password*, *recovery code*, *verification link*
     * would be wrong at the fourth provider — and being wrong there means the
     * thing that has to change hands has nowhere to go, which is the exact
     * failure the design exists for.
     */
    label: text('label').notNull(),

    /**
     * Whether what goes in here is a secret.
     *
     * **Declared when the slot is opened, before anything is in it**, so the
     * side that fills it is told what it is filling. A flag decided at fill time
     * would be decided by whoever happened to write first.
     */
    secret: boolean('secret').notNull().default(false),

    /**
     * Which side filled it — and therefore which direction the secret travelled
     * and which mechanism sealed it. One column, so no caller has to be told.
     */
    filledBy: slotFiller('filled_by'),

    filledAt: timestamp('filled_at', { withTimezone: true, mode: 'string' }),

    value: text('value'),
  },
  (table) => [
    /**
     * One label is one slot within one episode. Two rows called *password* on the
     * same episode is an ambiguity somebody resolves by guessing.
     */
    uniqueIndex('account_slots_label_unique').on(table.episodeId, table.label),

    /**
     * Filled is one fact with three columns, and a row where they disagree is a
     * slot that is half handed over — which reads, from either side, as the other
     * side not having done it yet.
     */
    check(
      'account_slots_filled_together',
      sql`(${table.filledBy} is null and ${table.filledAt} is null and ${table.value} is null)
          or (${table.filledBy} is not null and ${table.filledAt} is not null and ${table.value} is not null)`,
    ),

    check(
      'account_slots_label_fits',
      sql`length(${table.label}) between 1 and ${sql.raw(String(SLOT_LABEL_MAX_LENGTH))}`,
    ),

    check(
      'account_slots_value_fits',
      sql`${table.value} is null or length(${table.value}) <= ${sql.raw(String(SLOT_VALUE_MAX_LENGTH))}`,
    ),

    index('account_slots_episode_idx').on(table.episodeId),
  ],
)

/**
 * One note, appended.
 *
 * **No update path and no delete path, including for the author.** An episode is
 * what an operator reads to find out what happened, and a record either side
 * could revise afterwards is not that. What replaces editing is writing again:
 * the correction is a second entry, and the sequence shows somebody changed
 * their mind, which is usually the part worth knowing.
 *
 * The `UPDATE` refusal is a trigger — see the migration — because the storage
 * surface not offering one is a promise about today's code and the trigger is a
 * promise about tomorrow's.
 */
export const accountEntries = pgTable(
  'account_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    episodeId: uuid('episode_id')
      .notNull()
      .references(() => accountEpisodes.id, { onDelete: 'cascade' }),

    author: threadParty('author').notNull(),

    /** Line breaks preserved, nothing rendered. Both halves are decided in core. */
    body: text('body').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'account_entries_body_fits',
      sql`length(${table.body}) between 1 and ${sql.raw(String(ENTRY_BODY_MAX_LENGTH))}`,
    ),

    /** *This episode, in order* — the only read there is. */
    index('account_entries_episode_idx').on(table.episodeId, table.createdAt),
  ],
)
