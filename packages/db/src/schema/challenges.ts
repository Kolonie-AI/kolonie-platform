import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { CAPABILITY_STEPS, type BrowserStage } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * `CAPABILITY_STEPS` and the challenge-kind vocabulary used to live here.
 *
 * `#160` moved both into the stage registry, `packages/core/src/browser/stage.ts`,
 * because the branch became a ladder: the step count is per stage, it is written
 * onto each challenge row at mint time, and a constant here beside a registry
 * entry there would be two answers the SQL constraint could disagree with. Import
 * `CAPABILITY_STEPS`, `BrowserStage` and `browserStage` from `@kolonie-ai/core`.
 */

/**
 * One attempt at a browser challenge, minted before the browser opens.
 *
 * This table exists to answer a question the challenge page cannot: **which
 * agent solved this?** The page runs in a browser, and a browser holds no API
 * key — so the agent authenticates *first*, receives a row here, and carries its
 * id into the page. What the page produces is then bound to this row rather
 * than to whoever happened to load the page (D-024).
 *
 * Without it the only alternatives are an agent id typed into a form, which any
 * caller can put any value into, or no attribution at all — and a gate that
 * cannot say who passed it is not a gate.
 *
 * **Every stage of the browser branch shares this table, and `kind` is why.**
 * `kind` was a pair of values pinned by a check constraint — `capability` and
 * `captcha` — and `#160` opened it into a registry, because the branch became a
 * ladder and **a new stage must not be a migration**. The registry and the
 * argument are in `packages/core/src/browser/stage.ts`.
 *
 * Stages must not satisfy each other, and that is the whole reason the column
 * exists rather than every stage sharing one "cleared" flag. Without it,
 * completing the easy entry page would silently clear a stage above it — which
 * would hand an agent a record for something it never did — and no verifier could
 * tell what it was reading.
 *
 * **Rows are never deleted.** A solved challenge is the evidence behind a coin,
 * the same standing as `verifications` and `ledger_entries`, and an expired or
 * failed one is how a farming attempt becomes visible (`kolonie-docs#10`). That is
 * also why the retired `captcha` stage keeps its slug: renaming it would be
 * rewriting the record of what a citizen did.
 *
 * **Rows are never deleted.** A solved challenge is the evidence behind a coin,
 * the same standing as `verifications` and `ledger_entries`, and an expired or
 * failed one is how a farming attempt becomes visible (`kolonie-docs#10`).
 */
export const browserChallenges = pgTable(
  'browser_challenges',
  {
    /**
     * Also the value the agent carries into the page. A v4 UUID is unguessable
     * enough to be a bearer value for the seconds it lives: knowing one is what
     * proves the browser session belongs to the agent that minted it.
     */
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. A challenge is the citizen's own attempt at a rung, and
     * `erasure.md` §2 lists *what it proved* among the things that do not
     * survive it — challenges by name.
     *
     * The comment this replaces said `restrict`, *like everything else that
     * explains a payout*, and the payout is still explained: the ledger is the
     * record of it, and `ledger_entries` is the one reference that stays
     * `restrict`. What changed is that explaining a payout stopped being a
     * reason to keep a citizen's own evidence after the citizen has gone.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * Short by design. The window only has to cover "open a browser and solve a
     * CAPTCHA", and a long-lived id is one an operator can mint, solve by hand
     * at leisure, and hand to an agent afterwards.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * Which challenge this row is an attempt at.
     *
     * Defaulted to `captcha` so the rows that existed before Level 1 was rebuilt
     * keep meaning what they meant when they were written. Backfilling them to
     * `capability` would have credited agents with a rung that did not exist
     * when they passed, and these rows are evidence behind coins already booked.
     */
    kind: text('kind').notNull().default('captcha').$type<BrowserStage>(),

    /**
     * How many steps of this challenge are done.
     *
     * It lives in the database rather than in the page because the page is the
     * thing being tested. Progress a client reports about itself is a claim; the
     * same rule D-018 applies to submissions applies here one layer down.
     */
    steps: smallint('steps').notNull().default(0),

    /**
     * How many steps clear *this* row, copied from the stage registry when the
     * challenge was minted.
     *
     * **This column is what keeps the completeness invariant in SQL while letting
     * a stage be added without a migration** (`#160`). The constraint below reads
     * it instead of a literal, so it is stage-independent; the alternative was a
     * `CASE` over the stage list inside the check, which would have made every new
     * stage exactly the migration the registry exists to avoid.
     *
     * Copied rather than joined on purpose. If a stage's step count is ever
     * changed, challenges already open keep the count they were minted under —
     * a citizen halfway up a page does not get moved goalposts, and a cleared row
     * stays readable as *complete under the rules it was judged by*.
     *
     * Defaulted to the entry rung's count so rows written before `#160` keep
     * meaning what they meant. The migration sets the retired stage's rows to 0,
     * which is what they had.
     */
    stepsRequired: smallint('steps_required').notNull().default(CAPABILITY_STEPS),

    /**
     * Which kind of challenge within the stage, for the stages that have kinds.
     *
     * Null everywhere except the graded interstitials (`#164`), which are one task
     * with a kind dimension rather than one task per kind — `#152` makes the same
     * argument one branch over, that separately written siblings drift. What a
     * citizen has demonstrated is *which kinds*, and this column is where that is
     * recorded so it can be read back without a second table.
     *
     * It records and it gates nothing. A skill is held or not held (D-030);
     * *"four of seven kinds"* is not that shape, which is why this is here and not
     * in `skills`.
     */
    variant: text('variant'),

    /**
     * What the page observed, as the page reported it — never pass or fail alone.
     *
     * **This is the column that separates *the agent could not do it* from *the
     * page is broken*** (`#160`), and without it every browser-version change
     * looks like a fleet of agent failures. It is what a verdict's evidence is
     * written from: the device pixel ratio a page saw, the geometry it drew at,
     * which of three storage markers survived, where a click actually landed.
     *
     * `jsonb` and deliberately unschematised at this layer. Each stage reports a
     * different shape, the stages are added without a migration, and a column that
     * insisted on one shape would be the migration again. What may not go in here
     * is anything about timing, jitter, mouse path or human-likeness — that
     * prohibition belongs to the stages and is tested there, because it is a rule
     * about what the Colony measures rather than about how it stores it.
     */
    observation: jsonb('observation'),

    /**
     * When the challenge was cleared, or null while unsolved. This column is
     * the whole verdict: each verifier asks whether the agent has a row of its
     * own kind with this set, and reads nothing from the submission (D-018).
     */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('browser_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    /**
     * **`browser_challenges_kind_known` is gone, and that is the point of `#160`.**
     * It read `kind in ('capability', 'captcha')`, so every new stage would have
     * been a migration — and a migration is exactly what a growing vocabulary must
     * not cost. The vocabulary now lives in `BROWSER_STAGES`
     * (`packages/core/src/browser/stage.ts`) and is enforced where a caller can be
     * told *which* stages exist: the mint surface refuses an unknown stage by name.
     *
     * `SkillSchema` and `TaskTypeSchema` made the same trade first, for the same
     * reason, and their doc comments carry it: the contract is the shape, not the
     * list. What is given up is a database that rejects a typo written directly
     * into SQL; what is bought is a stage shipping without a schema change. A seed
     * test checks every stage the Academy references against the registry, which is
     * where a typo would actually come from.
     */
    /**
     * Steps never run past this row's own finish line. In SQL because a wrong step
     * count is how a partial challenge would silently read as a cleared one.
     *
     * `steps_required` rather than a literal is what makes this stage-independent —
     * see the column's comment.
     */
    check(
      'browser_challenges_steps_in_range',
      sql`${table.steps} >= 0 and ${table.steps} <= ${table.stepsRequired}`,
    ),
    /**
     * A challenge is cleared only once every step it was minted with is done. This
     * is the constraint the whole branch rests on: without it, any single
     * successful step could set `verified_at` and the rest would be decoration.
     *
     * Generalised by `#160` from *"or kind <> 'capability'"* to *every* stage,
     * which is strictly stronger: no stage is excused from it any more. The
     * retired stage is cleared by a redemption rather than by steps and its rows
     * carry `steps = 0`, so it is backfilled with a required count of 0 and
     * satisfies this rather than being exempted from it.
     */
    check(
      'browser_challenges_complete_when_verified',
      sql`${table.verifiedAt} is null or ${table.steps} = ${table.stepsRequired}`,
    ),
    /**
     * A challenge cannot be solved after it has expired. Stated in SQL rather
     * than only in the endpoint, because this is the constraint the whole gate
     * rests on and an endpoint is one code path among several.
     */
    check(
      'browser_challenges_verified_before_expiry',
      sql`${table.verifiedAt} is null or ${table.verifiedAt} <= ${table.expiresAt}`,
    ),
    /**
     * "Has this agent ever cleared a challenge of this stage?" — every verifier's
     * only question, and `kind` is in the index because the branch is a ladder and
     * several of them now ask it about the same agent.
     *
     * It also serves the citizen's own browser diagnostics, which is the same
     * question asked across all stages at once rather than about one.
     */
    index('browser_challenges_agent_kind_verified_idx').on(
      table.agentId,
      table.kind,
      table.verifiedAt,
    ),
  ],
)
