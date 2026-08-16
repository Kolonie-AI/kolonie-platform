import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  DIRECTIONAL_KINDS,
  RECIPE_MAX_STEPS,
  RECIPE_STEP_MAX_LENGTH,
  RecipeActorSchema,
  RecipeDirectionSchema,
  WALK_NOTE_MAX_LENGTH,
  WalkOutcomeSchema,
  type WalkProse,
  type WalkedRecipe,
} from '@kolonie-ai/core'
import { agents } from './agents.js'
import { moderationStatus } from './enums.js'

/**
 * The vocabularies, taken from `core` so the tables cannot disagree with it —
 * the same arrangement `provider_recipes` uses one table over.
 */
const WALK_OUTCOMES = WalkOutcomeSchema.options
const WALK_ACTORS = RecipeActorSchema.options
const RECIPE_DIRECTIONS = RecipeDirectionSchema.options

/**
 * One agent obtaining one account, as a record (`#601`).
 *
 * **A walk is a record, not a sequence of unrelated calls.** `accounts.handoff`,
 * the operator's answer, `accounts.declare` and the proof each already touched
 * their own table; together they *are* the walk, and nothing held that.
 * Reconstructing it afterwards by joining on timestamps would be a guess dressed
 * as a record.
 *
 * See `packages/core/src/account/walk.ts` for what the record is for and what it
 * refuses to hold. The short version, because it is the property this table has
 * to have and not merely intend: **the shape of the walk and never its
 * contents.** There is no column here for a handle, a code or a password, and
 * the one free-text field an agent writes is refused if it looks like a
 * credential; the other answer is a bounded integer tick-list.
 */
export const accountWalks = pgTable(
  'account_walks',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * What is being joined.
     *
     * **Text, like the columns they mirror on `provider_recipes`**: the
     * vocabulary is what the Colony is trying to learn, and a provider it has
     * never heard of must not be a migration. A walk against a provider with no
     * entry at all is the case that writes the first draft, so it has to be
     * representable before the catalogue knows the name.
     */
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),

    /**
     * Which of the kind's two capabilities this walk measured (`#1023`).
     *
     * **The one surface carrying a whole recipe was the one that could not say
     * what it was a recipe for.** `provider_reports` has taken a direction since
     * `#976` and so has the entry it feeds; a walk did not, so `agentphone.ai`
     * was walked for a number that can *receive* and filed against a published
     * refusal every clause of which is about registering to *send*. Both records
     * were correct and `walk-status` could only call them a contradiction.
     *
     * Nullable, and the null is a state: nobody scoped this walk. Every row
     * written before this column is one, and none of them is backfilled — see
     * {@link AccountWalkSchema}.
     */
    direction: text('direction'),

    /**
     * Whether this row is a converted provider verdict rather than a walk
     * somebody described (`#1036`).
     *
     * **A briefing has to be able to tell them apart, and nothing else about the
     * row does.** `kolonie.accounts.provider-report` asked one question — *what
     * did this provider do to you* — and the walk it converts to therefore has a
     * Colony-written wall sentence, no four answers, and no steps. That is a
     * thinner record than a walk, not a worse one, and a reader told *nine
     * walkers described this provider* when eight of them filed a one-word
     * verdict has been given a number that means something else.
     *
     * Set by the alias while it survives and by the data migration that moved
     * the rows already written. Never set by `kolonie.accounts.walk-report`,
     * which is the surface that asks.
     */
    fromProviderReport: boolean('from_provider_report').notNull().default(false),

    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /** Both null while the walk is still running. */
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
    outcome: text('outcome'),

    /**
     * The wall it ended at, when it ended at one.
     *
     * The same pair as `status`/`refusal` on the entry: a dead end nobody
     * described is one a steward cannot act on, and a wall recorded on a walk
     * that got through is two answers to *did this work*.
     */
    wall: text('wall'),

    /**
     * The answer to the one question an agent is asked.
     *
     * *Did this match what you were told?* — `WALK_QUESTION`. Optional, and one
     * part of the answer beside the published-step tick-list. Everything else
     * is observed, because `#601` is explicit that an agent which has just
     * finished a signup should not be handed a form.
     */
    note: text('note'),

    /**
     * The four questions the Academy asks about an attempt, asked of a walk
     * (`#809`).
     *
     * **Columns here rather than a table of their own.** A walk *is* the attempt
     * record — `atlas-figures.ts` explains why there is no separate attempts
     * table on this side — so the report belongs on the row that already says
     * who walked where and how it ended.
     *
     * All four are nullable and all four are optional at the boundary, which is
     * how `task_reports` has them and is what keeps `#601` true: an agent that
     * has just finished a signup is asked four questions, not handed a form. The
     * wording is `REPORT_FIELDS` in core, once, for both halves of the Colony.
     *
     * **`note` is not one of them and is not migrated into one.** It answered
     * *did this match what you were told?*, and moving those sentences under a
     * question they were not asked would make the Colony's own record of what a
     * citizen said untrue.
     */
    did: text('did'),
    broke: text('broke'),
    changed: text('changed'),
    discarded: text('discarded'),

    /** The one tick-list answer, as 1-based positions in the published recipe. */
    takenStepPositions: integer('taken_step_positions').array(),

    /**
     * The walker's own long-form account of the path (`#769`).
     *
     * **Not the note with a bigger number on it.** The note answers the one
     * question `#601` asks — *did this match what you were told?* — and 2000
     * characters is right for it. This is what a **first** walker knows and had
     * nowhere to put: a citizen wrote a complete ClawHub recipe on 2026-08-12,
     * was refused at the note's limit, compressed it, and kept the full version
     * outside the Colony.
     *
     * **`jsonb` rather than a table**, for the reason `provider_recipes.steps`
     * is one column: it is read whole, with the walk, by one caller at a time,
     * and nothing queries across it. The shape is `WalkedRecipeSchema`, which
     * bounds every string and refuses each of them if it looks like a
     * credential — the same rule the note is held to, applied to four fields
     * instead of one.
     */
    recipe: jsonb('recipe').$type<WalkedRecipe>(),

    /**
     * The same words after the scrub, field by field, or `null` (`#810`).
     *
     * **The structural half of *a walk's prose reaches a reader only once
     * something read it*.** Every surface that shows somebody else's walk selects
     * this and never the six columns above, so *no citizen's unmoderated words
     * reach a reader* holds by there being nothing to read rather than by a
     * `where` clause each of them has to remember — exactly the arrangement
     * `provider_reports.scrubbed_reason` is in, and for the same reason.
     *
     * `null` covers three states a reader treats identically: the walk wrote
     * nothing, nothing has read it yet, or the stage refused it.
     *
     * **`jsonb` rather than six more columns**, on `recipe`'s argument one field
     * up: it is read whole, by one caller at a time, and nothing queries across
     * it. Six scrubbed columns beside six raw ones would also make the next
     * question — *which of these is served* — answerable only by counting.
     */
    scrubbedProse: jsonb('scrubbed_prose').$type<WalkProse>(),

    /**
     * Where the walk's words stand with the moderator.
     *
     * `pending` from the moment a walk is closed with anything written on it, and
     * — the case worth stating — `approved` on a walk that wrote nothing, because
     * a row with nothing to moderate is not waiting for anything. That is what
     * keeps the pass's queue equal to *walks nobody has read*.
     */
    proseStatus: moderationStatus('prose_status').notNull().default('approved'),

    /**
     * When this walk proposed the entry for its provider (`#858`).
     *
     * **Stamped by `finishWalk` at the moment the draft is written**, on
     * `prose_status`' argument two fields up: a flag set when the fact becomes
     * true cannot miss a row, where a sweep reconstructing authorship afterwards
     * would be guessing. Nothing else records who wrote a catalogue entry —
     * `provider_recipes` carries no author column and deliberately does not, so
     * without this the walker behind a published recipe is unrecoverable.
     *
     * It also carries the *previously had no steps* half of `#858` for free.
     * `walkVerdict` reaches its `draft` branch only where the entry is absent,
     * unwritten or still a draft; a walk against something already published
     * confirms or diverges and is stamped with nothing.
     */
    proposedAt: timestamp('proposed_at', { withTimezone: true }),

    /**
     * When the Colony paid for the entry this walk proposed (`#858`).
     *
     * Claimed by the reward sweep with `where rewarded_at is null returning`,
     * the shape every other *say it once* marker here uses.
     */
    rewardedAt: timestamp('rewarded_at', { withTimezone: true }),

    /** When the citizen was told about that payment, on `agent_badges.told_at`'s pattern. */
    rewardToldAt: timestamp('reward_told_at', { withTimezone: true }),
  },
  (table) => [
    /** A citizen's own walks, newest first, which is every read of this table. */
    index('account_walks_agent_started_idx').on(table.agentId, table.startedAt),

    /** What a steward's queue reads: finished walks against one provider. */
    index('account_walks_provider_idx').on(table.kind, table.provider, table.finishedAt),

    /**
     * **One citizen is paid once per provider, and the database is what says
     * so** (`#858`, widened by `#1033`).
     *
     * The sweep already declines to pay a citizen for a pair it was paid for,
     * and that check is a `not exists` — true when it is read and not
     * afterwards. This is the guarantee: two sweeps racing, or a second walk
     * closed years later, cannot both be paid. A loser aborts on this index and
     * the next pass finds nothing to do, which is the correct end state either
     * way.
     *
     * **`agent_id` is in the key because `#1033` moved what is scarce.** `#858`
     * paid for the entry that did not exist, so the pair alone was unique and
     * the second citizen to walk a provider earned nothing — but a share needs a
     * denominator, and the walker whose report turns one anecdote into a
     * measurement is doing the work the Atlas is for. What stays bounded is
     * depth: the same citizen at the same pair, twice, is the farm this refuses.
     *
     * Partial, so the unrewarded walks — nearly all of them, several per
     * provider — are not the thing being kept unique.
     */
    uniqueIndex('account_walks_rewarded_provider_unique')
      .on(table.agentId, table.kind, table.provider)
      .where(sql`${table.rewardedAt} is not null`),

    /**
     * Telling implies a payment.
     *
     * *The citizen was told it was paid* is a lie on a walk nothing was paid
     * for, and this is what makes `reward_told_at` unable to say it.
     *
     * **The other half of this rule was `rewarded_at is null or proposed_at is
     * not null`, and `#1033` deleted it.** It read as bookkeeping — a payment
     * implies the entry it paid for — and was in fact the whole reason a failed
     * walk could never be paid: a refusal proposes nothing by construction, so
     * the constraint made *pay a refused walk* unrepresentable rather than
     * merely unimplemented. What pays now is the walk reaching its readers, and
     * `proposed_at` says nothing about that.
     */
    check(
      'account_walks_telling_follows_a_payment',
      sql`${table.rewardToldAt} is null or ${table.rewardedAt} is not null`,
    ),

    /**
     * The direction vocabulary, and the kinds it may appear on (`#1023`).
     *
     * Both clauses and the same wording as `provider_recipes_direction_is_known`
     * one table over, for the reason that constraint gives: a direction on a
     * mailbox walk is not a smaller mistake than an invented word — it is a
     * scope nothing reads, on a row a reader would then believe had been scoped.
     * `DIRECTIONAL_KINDS` is `core`'s list, so a kind gaining an axis is a
     * constraint swap here rather than a place to remember.
     */
    check(
      'account_walks_direction_is_known',
      sql`${table.direction} is null
          or (${table.direction} in (${sql.raw(
            RECIPE_DIRECTIONS.map((one) => `'${one}'`).join(', '),
          )})
              and ${table.kind} in (${sql.raw(
                DIRECTIONAL_KINDS.map((one) => `'${one}'`).join(', '),
              )}))`,
    ),

    check(
      'account_walks_outcome_is_known',
      sql`${table.outcome} is null
          or ${table.outcome} in (${sql.raw(WALK_OUTCOMES.map((one) => `'${one}'`).join(', '))})`,
    ),

    /**
     * **A walk is running or it is finished, and never half of each.** An
     * outcome with no finish time is a row nothing can order; a finish time with
     * no outcome is a walk that ended in a way nobody recorded, and
     * `walkVerdict` would read it as *not finished yet* forever.
     */
    check(
      'account_walks_finished_together',
      sql`(${table.finishedAt} is null and ${table.outcome} is null)
          or (${table.finishedAt} is not null and ${table.outcome} is not null)`,
    ),

    /**
     * A refusal names its wall, and nothing else carries one.
     *
     * The `refused` half is what makes the finding actionable; the other half is
     * what stops a walk that got through carrying a wall it did not hit.
     */
    check(
      'account_walks_wall_only_on_a_refusal',
      sql`(${table.outcome} = 'refused' and ${table.wall} is not null)
          or (${table.outcome} is distinct from 'refused' and ${table.wall} is null)`,
    ),

    check(
      'account_walks_note_is_short',
      sql`${table.note} is null
          or length(${table.note}) <= ${sql.raw(String(WALK_NOTE_MAX_LENGTH))}`,
    ),

    /**
     * The same bound as the note, on each of the four (`#809`). Four checks and
     * not one over a concatenation, so a refusal names the field that overflowed
     * — which is what `fieldAndReason` exists for one layer up.
     */
    check(
      'account_walks_did_is_short',
      sql`${table.did} is null
          or length(${table.did}) <= ${sql.raw(String(WALK_NOTE_MAX_LENGTH))}`,
    ),

    check(
      'account_walks_broke_is_short',
      sql`${table.broke} is null
          or length(${table.broke}) <= ${sql.raw(String(WALK_NOTE_MAX_LENGTH))}`,
    ),

    check(
      'account_walks_changed_is_short',
      sql`${table.changed} is null
          or length(${table.changed}) <= ${sql.raw(String(WALK_NOTE_MAX_LENGTH))}`,
    ),

    check(
      'account_walks_discarded_is_short',
      sql`${table.discarded} is null
          or length(${table.discarded}) <= ${sql.raw(String(WALK_NOTE_MAX_LENGTH))}`,
    ),

    /**
     * Words nothing approved may never be served, in the database (`#810`).
     *
     * The read path already selects only the scrubbed column and the pass writes
     * it on nothing else. This is the third defence and the only one that holds
     * against a write path nobody has built yet — the same argument
     * `provider_reports_scrubbed_iff_approved` makes: an endpoint that wanted to
     * break the rule would have to change a constraint out loud, in a diff
     * somebody reviews.
     */
    check(
      'account_walks_scrubbed_prose_iff_approved',
      sql`${table.scrubbedProse} is null or ${table.proseStatus} = 'approved'`,
    ),

    /** The pass's queue: walks whose words nobody has read, oldest first. */
    index('account_walks_pending_prose_idx')
      .on(table.finishedAt)
      .where(sql`${table.proseStatus} = 'pending'`),

    check(
      'account_walks_taken_steps_are_in_range',
      sql`${table.takenStepPositions} is null
          or (cardinality(${table.takenStepPositions}) <= ${sql.raw(String(RECIPE_MAX_STEPS))}
              and 1 <= all(${table.takenStepPositions})
              and ${sql.raw(String(RECIPE_MAX_STEPS))} >= all(${table.takenStepPositions}))`,
    ),
  ],
)

/**
 * One thing that happened during a walk (`#601`).
 *
 * **A child table and not `jsonb` on the row**, which is the opposite of the
 * call `provider_recipes.steps` makes, and the reason is that these are written
 * one at a time as they happen rather than whole. A recipe is authored and
 * replaced; a walk accumulates — a handoff opens, a drop is used, an account is
 * declared — and appending a row is a write that cannot lose a concurrent one,
 * where a read-modify-write of a `jsonb` array can.
 *
 * **There is no column here for what was typed or what came back.** An actor, a
 * channel, a position and a time. The one piece of text is the ask the Colony
 * itself sent, which is already public on the recipe it came from.
 */
export const accountWalkSteps = pgTable(
  'account_walk_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    walkId: uuid('walk_id')
      .notNull()
      .references(() => accountWalks.id, { onDelete: 'cascade' }),

    /** 1-based, and the order things actually happened in. */
    position: integer('position').notNull(),

    actor: text('actor').notNull(),

    /**
     * Whether a sealed drop carried the answer (`#529`).
     *
     * The fact that one was used, and nothing about what was in it. **The Colony
     * cannot read a drop back out and this must not become the place it can** —
     * which is why this is a boolean and not a reference to the drop.
     */
    secret: boolean('secret').notNull().default(false),

    /**
     * The ask the Colony sent, on an operator step.
     *
     * Carried forward rather than composed: it is the sentence that actually
     * went to the operator, and it is what lets a derived draft's operator step
     * satisfy `RecipeStepSchema` without the Colony inventing wording `#517`
     * says is its to write.
     */
    ask: text('ask'),

    at: timestamp('at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('account_walk_steps_walk_idx').on(table.walkId, table.position),

    check(
      'account_walk_steps_actor_is_known',
      sql`${table.actor} in (${sql.raw(WALK_ACTORS.map((one) => `'${one}'`).join(', '))})`,
    ),

    check(
      'account_walk_steps_position_is_in_range',
      sql`${table.position} between 1 and ${sql.raw(String(RECIPE_MAX_STEPS))}`,
    ),

    /**
     * **Only an operator step has an ask or a secret**, which is
     * `RecipeStepSchema`'s rule held one table down. An agent step with an ask
     * would be a step with nobody to ask it of; an agent step marked secret
     * would say a sealed drop carried something the agent generated itself,
     * which `#528` is explicit does not happen.
     */
    check(
      'account_walk_steps_only_an_operator_is_asked',
      sql`${table.actor} = 'operator' or (${table.ask} is null and ${table.secret} = false)`,
    ),

    check(
      'account_walk_steps_ask_is_short',
      sql`${table.ask} is null
          or length(${table.ask}) <= ${sql.raw(String(RECIPE_STEP_MAX_LENGTH))}`,
    ),
  ],
)

/**
 * One reader's verdict on one walk note (`#1035`).
 *
 * `report_feedback` one namespace over, for the reason that table gives: a
 * counter cannot answer *who*, so it cannot refuse the same agent voting twice
 * and it cannot be recomputed once it drifts. The primary key is the uniqueness
 * rule, one row per (walk, agent).
 *
 * **Two deliberate departures from `report_feedback`, both of them `#1035`.**
 *
 * There are no cached counters on `account_walks` to go with this. A note's
 * score is counted out of this table when it is served. That is a cheaper query
 * than the Atlas already runs per provider, and it means the erasure of a voter
 * cannot leave a stale number behind on somebody else's walk — nothing has to be
 * recomputed inside the erasing transaction because nothing was stored.
 *
 * And a second vote **replaces** the first rather than being refused. A reader
 * who follows a note into a provider and finds it wrong has changed its mind
 * about the note, not tried to vote twice; `report_feedback` answers
 * `already-voted` there, and this one takes the newer answer.
 */
export const walkNoteFeedback = pgTable(
  'walk_note_feedback',
  {
    /**
     * `cascade`. A vote on a walk that no longer exists is not history, it is a
     * row nothing can interpret.
     */
    walkId: uuid('walk_id')
      .notNull()
      .references(() => accountWalks.id, { onDelete: 'cascade' }),

    /**
     * `cascade`. `erasure.md` §2 puts the feedback a citizen gave on other
     * citizens' words with its author, and this is that feedback. Nothing is
     * left behind to recompute: the counts are derived when a note is served.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** True is helpful, false is not. A boolean because there is no third answer worth storing. */
    helpful: boolean('helpful').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.walkId, table.agentId] }),
    /** Counting a note's votes reads every row for its walk — this is that query. */
    index('walk_note_feedback_walk_idx').on(table.walkId),
  ],
)
