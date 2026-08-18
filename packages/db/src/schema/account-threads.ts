import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  DROP_VALUE_MAX_LENGTH,
  ENTRY_BODY_MAX_LENGTH,
  EPISODE_TITLE_MAX_LENGTH,
  EPISODE_WALL_MAX_LENGTH,
  HANDOVER_VALUE_MAX_LENGTH,
  SLOT_LABEL_MAX_LENGTH,
  SLOT_MAX_READS,
  SLOT_VALUE_MAX_LENGTH,
  VAULT_KEY_MAX_LENGTH,
} from '@kolonie-ai/core'
import { accounts } from './accounts.js'
import { agents } from './agents.js'
import { episodeKind, episodeOutcome, episodeTurn, slotFiller, threadParty } from './enums.js'
import { tasks } from './tasks.js'

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

    /**
     * When closing this episode proposed an Atlas draft (`#935`).
     *
     * **This is the attribution, and it is here because there is nowhere else
     * for it.** `provider_recipes` carries no author column and deliberately
     * does not — an entry is the Colony's sentence, not a byline — so *whose
     * episode became this draft* is recorded on the episode, at the only moment
     * the fact exists. `account_walks.proposed_at` is the same column for the
     * same reason, and this is deliberately its twin rather than a new idea.
     *
     * Null on every episode that proposed nothing, which is most of them: a
     * maintenance episode, an abandoned one, one against a published entry.
     */
    proposedAt: timestamp('proposed_at', { withTimezone: true, mode: 'string' }),
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
     * **At most one open maintenance episode the Colony opened** (`#934`).
     *
     * A provider down for a day fails every re-check it is asked, and each
     * failure would otherwise open its own episode — a page of identical rows
     * about one outage. The application appends to the open one instead; this
     * makes that structural, so two probers racing produce one episode and the
     * loser appends.
     *
     * **Scoped to `colony` on purpose.** The agent and the operator may open as
     * many maintenance episodes as they have things to repair, and an index that
     * stopped them would be this rule reaching somewhere it was never about.
     */
    uniqueIndex('account_episodes_one_open_colony_maintenance')
      .on(table.threadId)
      .where(
        sql`${table.kind} = 'maintenance' and ${table.outcome} is null and ${table.openedBy} = 'colony'`,
      ),

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

    /**
     * The episode this slot belongs to — **null on a slot that is a channel**
     * (`#955`).
     *
     * A drop and a handover are opened against a provider and a step rather than
     * against a conversation, so they have no episode and manufacturing one would
     * write history that did not happen: a turn nobody took, a title nobody wrote,
     * and an outcome that never comes.
     */
    episodeId: uuid('episode_id').references(() => accountEpisodes.id, { onDelete: 'cascade' }),

    /**
     * The citizen a channel slot belongs to — **null on an episode slot**
     * (`#955`).
     *
     * `#931` said the slot's owner would be the thread, and that is what an
     * episode slot has. A drop and a handover have no account, so they have no
     * thread either: the drop is opened against a task, the handover against a
     * provider, and neither names an account the Colony holds. So the owner of a
     * channel slot is the agent, which is what `operator_drops` and
     * `agent_handovers` each carried before this table absorbed them.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Which older channel this slot is, and null on an episode slot (`#955`).
     *
     * One column decides which shape the rest of the row is in, so that every
     * check below can name the shape it is talking about instead of inferring it
     * from which columns happen to be filled.
     */
    channel: text('channel'),

    /**
     * Free text, and the alternative was considered and refused.
     *
     * A closed vocabulary of *password*, *recovery code*, *verification link*
     * would be wrong at the fourth provider — and being wrong there means the
     * thing that has to change hands has nowhere to go, which is the exact
     * failure the design exists for.
     *
     * **Null on a channel slot** (`#955`). A drop has a prompt and a handover has
     * a provider; neither has a label, and a filler value would be a name nobody
     * chose sitting in the column whose whole point is that somebody did.
     */
    label: text('label'),

    /**
     * Whether what goes in here is a secret.
     *
     * **Declared when the slot is opened, before anything is in it**, so the
     * side that fills it is told what it is filling. A flag decided at fill time
     * would be decided by whoever happened to write first.
     */
    secret: boolean('secret').notNull().default(false),

    /**
     * Which side is expected to fill it, declared at open (`#931`).
     *
     * **This is what folds the two secret channels into one object.** Awaiting
     * the operator is the drop's direction: the value lands in the agent's vault
     * under {@link vaultKey}, sealed from the Colony. Awaiting the agent is the
     * handover's: the value is sealed for the operator's signed-in console and
     * spent by {@link reads}. Neither mechanism is new and neither is changed —
     * what is new is that a slot can say which account the secret is about,
     * which is the thing the two separate calls could not do.
     *
     * Declared at open for the same reason {@link secret} is: a direction
     * decided at fill time would be decided by whoever happened to write first.
     */
    awaits: slotFiller('awaits').notNull().default('agent'),

    /**
     * Where an operator-filled secret is to land — **named by the agent**.
     *
     * The operator never chooses it and there is no request shape through which
     * it could. `operator_drops` holds the same rule and states the reason: an
     * operator that could name the key could overwrite a credential the agent
     * depends on. `#931` keeps that protection exactly rather than restating it
     * more weakly.
     */
    vaultKey: varchar('vault_key', { length: VAULT_KEY_MAX_LENGTH }),

    /**
     * Which side filled it — and therefore which direction the secret travelled
     * and which mechanism sealed it. One column, so no caller has to be told.
     */
    filledBy: slotFiller('filled_by'),

    filledAt: timestamp('filled_at', { withTimezone: true, mode: 'string' }),

    value: text('value'),

    /**
     * When the secret in here was taken, and null on every slot that is not a
     * secret one (`#930`).
     *
     * **Taking is what spends it**, which is the rule `operator_drops` already
     * holds and the reason `kolonie.operator.drop.read` is its own call. A spend
     * that left no mark is one nothing could refuse a second time, so the mark
     * is a column rather than an inference from the vault.
     */
    takenAt: timestamp('taken_at', { withTimezone: true, mode: 'string' }),

    /**
     * The vault key it landed under — a plaintext label, never the value.
     *
     * Kept so that refusing the second take can say where the first one went,
     * which is the answer a caller that lost its transcript actually needs.
     */
    takenTo: text('taken_to'),

    /**
     * When a secret stops answering, and null on every slot that is not one
     * (`#931`).
     *
     * **The cap and not the whole rule.** A slot lives as long as its episode;
     * closing the episode destroys what is in it whether or not this has passed.
     * Seven days is what covers the episode nobody ever closes, which is the
     * ordinary end of abandoned work rather than a rare one.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),

    /**
     * How many times the operator has read it.
     *
     * `agent_handovers` holds the same column for the same reason, and the
     * reason is a person rather than a program: they double-click, they hit
     * back, they open it again on the laptop. A single read is a channel that
     * fails on ordinary human behaviour.
     */
    reads: integer('reads').notNull().default(0),

    /**
     * When the value went, by the last read, the timer, or the episode closing.
     *
     * **The row survives what it held.** An operator reading the conversation
     * afterwards should find *there was a password here and it is gone* rather
     * than nothing at all, and the two are different facts about an account.
     */
    destroyedAt: timestamp('destroyed_at', { withTimezone: true, mode: 'string' }),

    /**
     * When the slot was opened. Null on an episode slot, where the episode's own
     * entries already carry the sequence and a second clock would be a second
     * answer to *when did this start*.
     *
     * A channel slot has no entries, so this is the only thing that can order a
     * citizen's open drops for it (`#955`).
     */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }),

    /**
     * When the operator last read a handover, so that the console can say *you
     * have already seen this once* rather than only counting (`#955`).
     */
    lastReadAt: timestamp('last_read_at', { withTimezone: true, mode: 'string' }),

    /**
     * What the operator is being asked for, in the agent's own words (`#955`).
     *
     * A channel is opened at a person who was not expecting it, so the ask has to
     * travel with the slot. An episode slot has the episode's title and entries
     * instead, and this stays null there.
     */
    prompt: text('prompt'),

    /**
     * A drop's kind — `code` or `credential` — and null everywhere else.
     *
     * It decides where the answer lands: a code comes back to the caller once, a
     * credential goes into the vault under `vault_key` and never returns through
     * a transcript.
     */
    kind: text('kind'),

    /**
     * SHA-256 of the single-use token in the mailed link, hex — **never the token
     * itself**, which the Colony holds for exactly as long as it takes to send it.
     *
     * Only a drop has one. A handover is read from a signed-in console, and the
     * absence of a token there is the guarantee rather than an omission.
     */
    tokenHash: text('token_hash'),

    /**
     * The task a code drop was opened against, so that a code arriving can be
     * matched to the challenge it answers.
     */
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),

    /**
     * Who runs the account a handover is for, as one token. Not a foreign key:
     * a handover is opened at any provider, walked or not.
     */
    provider: text('provider'),

    /**
     * How many times the mailed link has been answered wrongly.
     *
     * Counted before the value is even looked at, so that a link being guessed at
     * runs out whether or not any guess was close.
     */
    attempts: integer('attempts').notNull().default(0),
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
     *
     * **Destroyed is the third state, and leaving it out made every destruction
     * path throw** (`#955`). `destroyed_at` is documented one screen up as *the
     * row survives what it held*, and a row that has survived what it held is a
     * row whose `filled_by` and `filled_at` stand over an absent value — exactly
     * what the two branches above forbid. Nothing reported it because no test
     * ever filled a *secret* slot and then destroyed one, and production has
     * never carried a slot secret at all: measured on 2026-08-15 as 0 of 0. All
     * three destroyers wrote the same forbidden row — the last read in
     * {@link readSlotAsOperator}, closing the episode, and the sweep.
     */
    check(
      'account_slots_filled_together',
      sql`(${table.filledBy} is null and ${table.filledAt} is null and ${table.value} is null)
          or (${table.filledBy} is not null and ${table.filledAt} is not null and ${table.value} is not null)
          or (${table.filledBy} is not null and ${table.filledAt} is not null and ${table.value} is null and ${table.destroyedAt} is not null)`,
    ),

    /**
     * A label is one to {@link SLOT_LABEL_MAX_LENGTH} characters where there is
     * one at all. A channel slot has none — see `label` above — and `is null or`
     * is what says so rather than a length of zero, which would be a name that is
     * present and empty.
     */
    check(
      'account_slots_label_fits',
      sql`${table.label} is null or length(${table.label}) between 1 and ${sql.raw(String(SLOT_LABEL_MAX_LENGTH))}`,
    ),

    /**
     * How long a value may be, per shape — because what is in the column is not
     * the same thing on each of them (`#955`).
     *
     * An episode slot holds a plaintext, and {@link SLOT_VALUE_MAX_LENGTH} is the
     * bound the caller was given. A channel holds a **sealed envelope**: base64
     * over AES-256-GCM, which is about a third longer than what went into it, so
     * measuring the envelope against the plaintext's bound would refuse a value
     * the caller was told it could send. `agent_handovers` already stated the
     * multiplier and it is kept exactly; `operator_drops` had no bound at all, so
     * the same multiplier over its own plaintext bound is a ceiling where there
     * was none rather than a narrowing of one.
     */
    check(
      'account_slots_value_fits',
      sql`${table.value} is null
          or (${table.channel} is null and length(${table.value}) <= ${sql.raw(String(SLOT_VALUE_MAX_LENGTH))})
          or (${table.channel} = 'drop' and length(${table.value}) <= ${sql.raw(String(DROP_VALUE_MAX_LENGTH * 4))})
          or (${table.channel} = 'handover' and length(${table.value}) <= ${sql.raw(String(HANDOVER_VALUE_MAX_LENGTH * 4))})`,
    ),

    /**
     * Only a secret is spent by being taken, and only a filled slot has
     * anything to spend. Both directions of the same fact, so a row cannot
     * claim a take that could not have happened.
     */
    check(
      'account_slots_taken_is_a_secret',
      sql`${table.takenAt} is null or (${table.secret} and ${table.filledAt} is not null)`,
    ),

    /**
     * Taken and where-it-went are one fact on an episode slot: the take puts the
     * secret in the vault, and a take that could not say where would be a spend
     * nothing could account for.
     *
     * **A code drop is the exception and it is not a weakening** (`#955`). A code
     * is handed back to the caller once and lands nowhere by design — there is no
     * vault key on it, and `account_slots_drop_kind_shape` below forbids one. So
     * on a channel the pairing is dropped and the take is recorded alone, which
     * is exactly what `operator_drops` allowed through `read_at` before this table
     * absorbed it.
     */
    check(
      'account_slots_taken_together',
      sql`(${table.takenAt} is null and ${table.takenTo} is null)
          or (${table.takenAt} is not null and ${table.takenTo} is not null)
          or (${table.takenAt} is not null and ${table.channel} is not null)`,
    ),

    /**
     * A slot is filled by the side it was opened for, and by nobody else
     * (`#931`).
     *
     * The direction decides which mechanism seals the value, so a row where the
     * wrong side filled it is a row whose secret was sealed the wrong way — and
     * that failure is silent until somebody tries to read it, days later, when
     * the thing it was protecting has already been used.
     */
    check(
      'account_slots_filled_by_the_awaited',
      sql`${table.filledBy} is null or ${table.filledBy} = ${table.awaits}`,
    ),

    /**
     * A vault key belongs to exactly one shape of slot: a secret the operator
     * fills. On anything else it would name a landing place for a value that is
     * never going to travel that way, which is a promise the row cannot keep.
     */
    check(
      'account_slots_vault_key_is_for_the_operator',
      sql`${table.vaultKey} is null or (${table.secret} and ${table.awaits} = 'operator')`,
    ),

    /**
     * Every secret has a timer and nothing else has one. A secret that could
     * sit without an expiry would be the one case where the Colony holds a
     * credential indefinitely, which is the property this whole channel exists
     * not to have.
     */
    check('account_slots_secrets_expire', sql`(${table.expiresAt} is not null) = ${table.secret}`),

    check(
      'account_slots_reads_bounded',
      sql`${table.reads} >= 0 and ${table.reads} <= ${sql.raw(String(SLOT_MAX_READS))}`,
    ),

    /** Only a secret is read out this way, so only a secret can have been. */
    check('account_slots_reads_are_a_secrets', sql`${table.reads} = 0 or ${table.secret}`),

    /**
     * Destroyed means the value is gone, and the row cannot say otherwise.
     *
     * One direction only, unlike `agent_handovers_destroyed_holds_nothing`: a
     * slot that has never been filled also holds nothing, and it is not
     * destroyed. The half worth enforcing is the half that would be a lie.
     */
    check(
      'account_slots_destroyed_holds_nothing',
      sql`${table.destroyedAt} is null or ${table.value} is null`,
    ),

    /**
     * A slot belongs to an episode or to a citizen, and to exactly one of them
     * (`#955`).
     *
     * `#931` gave the slot an episode because every slot it knew about hung off a
     * conversation about an account. A drop and a handover do not: they are
     * opened against a task or a provider, before there is an account to have a
     * conversation about. So the owner is one column or the other, never both and
     * never neither, and `channel` and `label` agree with whichever it is — which
     * is what lets every check above name a shape instead of guessing at one.
     */
    check(
      'account_slots_owner',
      sql`((${table.episodeId} is not null) != (${table.agentId} is not null))
          and (${table.channel} is null) = (${table.episodeId} is not null)
          and (${table.label} is null) = (${table.channel} is not null)`,
    ),

    /**
     * Each channel carries its own columns and none of the other's.
     *
     * A drop is answered through a mailed single-use link, so it has a kind and a
     * token hash. A handover is read from a signed-in console and has a provider
     * and **no token at all** — that absence is the guarantee that a link cannot
     * be forwarded into it, and a nullable column shared with drops would let a
     * future write put one there.
     */
    check(
      'account_slots_channel_shape',
      sql`(${table.channel} is null
            and ${table.kind} is null and ${table.tokenHash} is null
            and ${table.provider} is null and ${table.taskId} is null
            and ${table.prompt} is null and ${table.attempts} = 0)
          or (${table.channel} = 'drop'
            and ${table.kind} is not null and ${table.tokenHash} is not null
            and ${table.createdAt} is not null
            and ${table.provider} is null and ${table.prompt} is not null)
          or (${table.channel} = 'handover'
            and ${table.provider} is not null and ${table.prompt} is not null
            and ${table.createdAt} is not null
            and ${table.kind} is null and ${table.tokenHash} is null
            and ${table.taskId} is null and ${table.attempts} = 0)`,
    ),

    /**
     * A drop's kind decides where its answer lands, and the row has to be able to
     * take it there. `operator_drops_kind_shape` held this and it is carried over
     * unchanged: a credential names the vault key it lands under, a code names
     * the task whose challenge it answers, and neither has the other's column.
     */
    check(
      'account_slots_drop_kind_shape',
      sql`${table.channel} is distinct from 'drop'
          or (${table.kind} = 'credential' and ${table.vaultKey} is not null and ${table.taskId} is null)
          or (${table.kind} = 'code' and ${table.vaultKey} is null and ${table.taskId} is not null)`,
    ),

    /**
     * A count of wrong answers is not negative.
     *
     * **No ceiling here, deliberately.** {@link MAX_DROP_ATTEMPTS} is enforced
     * where the attempt is counted, and `operator_drops_attempts_positive` said
     * exactly this and nothing more. Writing the ceiling into the table would
     * make the migration that carries those rows over fail on any row the old
     * table permitted — and the only way past that is to clamp the count, which
     * is inventing a number to satisfy a constraint nobody needed.
     */
    check('account_slots_attempts_positive', sql`${table.attempts} >= 0`),

    index('account_slots_episode_idx').on(table.episodeId),

    /** A citizen's own channels, oldest first — what `kolonie.operator.drops` reads. */
    index('account_slots_agent_idx').on(table.agentId, table.createdAt),

    /**
     * One token answers one drop. Partial, because every other row has no token
     * and Postgres would otherwise be asked to keep them apart from each other.
     */
    uniqueIndex('account_slots_token_hash_idx')
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} is not null`),

    /**
     * The sweep's index: secrets still holding something, oldest expiry first.
     * Partial, because the rows it will never look at outnumber the rest within
     * a week of any busy episode.
     */
    index('account_slots_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.destroyedAt} is null and ${table.expiresAt} is not null`),
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
