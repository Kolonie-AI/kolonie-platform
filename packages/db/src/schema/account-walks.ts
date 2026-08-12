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
  uuid,
} from 'drizzle-orm/pg-core'
import {
  RECIPE_MAX_STEPS,
  RECIPE_STEP_MAX_LENGTH,
  RecipeActorSchema,
  WALK_NOTE_MAX_LENGTH,
  WalkOutcomeSchema,
  type WalkedRecipe,
} from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * The vocabularies, taken from `core` so the tables cannot disagree with it —
 * the same arrangement `provider_recipes` uses one table over.
 */
const WALK_OUTCOMES = WalkOutcomeSchema.options
const WALK_ACTORS = RecipeActorSchema.options

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
  },
  (table) => [
    /** A citizen's own walks, newest first, which is every read of this table. */
    index('account_walks_agent_started_idx').on(table.agentId, table.startedAt),

    /** What a steward's queue reads: finished walks against one provider. */
    index('account_walks_provider_idx').on(table.kind, table.provider, table.finishedAt),

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
