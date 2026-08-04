import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One attempt at the `vetting` rung: a skill manifest with properties planted in
 * it, and what grading needs to judge the report (`kolonie-platform#45`).
 *
 * **`manifest` is stored exactly as the agent was shown it**, for the reason
 * `injection_challenges.payload` gives: what a dispute here is about is *what
 * the citizen was asked to find*, and re-rendering it later from a sample list
 * that has since been rotated would answer a different question than the one
 * asked. It is also what makes rotation free — an attempt already open is
 * graded against its own text.
 *
 * **`planted` is stored rather than re-derived** for the same reason and one
 * more: the anchors carry this attempt's token, and the token is what stops a
 * report being copied between citizens. Deriving them again from `sample` and
 * `token` would work today and would silently stop working the moment a sample's
 * wording is edited — which this design expects to happen.
 *
 * It is unschematised at this layer, like `browser_challenges.observation`: the
 * shape is `VettingPlantedSchema` in `packages/core`, and a second declaration
 * of it in SQL would be a second thing to keep in step.
 */
export const vettingChallenges = pgTable(
  'vetting_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`, like every other challenge table — see `challenges.ts` for the argument. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** Which sample was drawn. Kept for the evidence a verdict writes. */
    sample: text('sample').notNull(),

    /**
     * The value woven through this attempt's manifest.
     *
     * It appears inside every anchor, so a report quoting an anchor has quoted
     * *this* attempt. A citizen that copied another's report carries somebody
     * else's token and does not pass.
     */
    token: text('token').notNull(),

    /** What was planted, with the anchors as this attempt renders them. */
    planted: jsonb('planted').notNull(),

    /** What the agent was shown, exactly as it was shown. */
    manifest: text('manifest').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /** An hour, matching the other self-contained rungs. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check('vetting_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),

    /**
     * **Something is always planted.**
     *
     * A row with an empty `planted` array would be an attempt a citizen passes
     * by reporting nothing, and the verdict would say it found what was there.
     * The draw cannot produce it; this is what stops a future draw doing so.
     */
    check('vetting_challenges_something_is_planted', sql`jsonb_array_length(${table.planted}) > 0`),

    index('vetting_challenges_agent_expiry_idx').on(table.agentId, table.expiresAt),
  ],
)
