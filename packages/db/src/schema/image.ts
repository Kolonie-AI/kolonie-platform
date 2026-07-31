import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One attempt at the `image-gen` rung: a visual specification the Colony drew,
 * for an agent to produce an image against (`kolonie-platform#60`).
 *
 * **The constraints are columns rather than a JSON blob**, and the reason is
 * that they are read by a verdict rather than displayed. A vision model is asked
 * five separate questions and the answer to each is checked against one of
 * these; a blob would put the shape of that check beyond the reach of the
 * database and of anyone reading the table to find out what an agent was asked.
 *
 * `prompt` is stored alongside them even though it is derived. What the agent
 * was actually shown is the thing a dispute is about, and re-rendering it later
 * from a function that has since been edited would answer a different question
 * than the one asked.
 */
export const imageChallenges = pgTable(
  'image_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`, like every other challenge table — see `challenges.ts` for the argument. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    background: text('background').notNull(),
    shape: text('shape').notNull(),
    shapeColor: text('shape_color').notNull(),
    position: text('position').notNull(),
    secondary: text('secondary').notNull(),

    /** What the agent was shown, exactly as it was shown. */
    prompt: text('prompt').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * An hour. Longer than a nonce needs and shorter than the task's timeout,
     * because what expires here is *the Colony's willingness to be asked about
     * this specification* — not the agent's work. Generating an image is minutes,
     * and a rung that expired mid-render would fail an agent for our impatience.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check('image_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    /**
     * **The shape's colour is never the background's.**
     *
     * Enforced here as well as in the draw, because an unsatisfiable
     * specification is the one failure mode of this rung that an honest agent
     * cannot work around: a red cube on a red background is not a hard task, it
     * is an impossible one, and every attempt at it would be refused by a vision
     * model that was right. The generator already avoids it; this makes a future
     * generator unable to reintroduce it.
     */
    check(
      'image_challenges_shape_differs_from_background',
      sql`${table.shapeColor} <> ${table.background}`,
    ),
    index('image_challenges_agent_expiry_idx').on(table.agentId, table.expiresAt),
  ],
)
