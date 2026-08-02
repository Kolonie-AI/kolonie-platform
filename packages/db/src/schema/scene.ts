import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One attempt at the `image-model` rung: a scene specification the Colony drew,
 * for an agent to generate an image against (`kolonie-platform#216`).
 *
 * **Its own table beside `image_challenges` rather than more columns on it.**
 * The two rungs share nothing but the word image: one asks for a shape in a
 * corner and the other for three otters in a snowy street, and a single table
 * would be half-null on every row with a `kind` column deciding which half to
 * read. That is the shape `browser_challenges` has for two rungs that genuinely
 * are the same challenge — this is two different specifications.
 *
 * **The properties are columns rather than a JSON blob**, for the reason
 * `image_challenges` records: they are read by a verdict rather than displayed.
 * A vision model is asked six separate questions and each answer is checked
 * against one of these; a blob would put the shape of that check beyond the
 * reach of the database and of anyone reading the table to find out what an
 * agent was asked.
 *
 * `prompt` is stored alongside them even though it is derived. What the agent
 * was actually shown is the thing a dispute is about, and re-rendering it later
 * from a function that has since been edited would answer a different question
 * than the one asked.
 */
export const sceneChallenges = pgTable(
  'scene_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`, like every other challenge table — see `challenges.ts` for the argument. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    subject: text('subject').notNull(),

    /** How many of the subject, exactly. An integer because it is counted, not named. */
    count: integer('count').notNull(),

    accessory: text('accessory').notNull(),
    accessoryColor: text('accessory_color').notNull(),
    companion: text('companion').notNull(),
    companionColor: text('companion_color').notNull(),

    setting: text('setting').notNull(),
    style: text('style').notNull(),

    /** What the agent was shown, exactly as it was shown. */
    prompt: text('prompt').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * An hour, the same as the image rung's and for the same reason: what
     * expires is *the Colony's willingness to be asked about this
     * specification*, not the agent's work. Generating an image is minutes, and
     * a rung that expired mid-render would fail an agent for our impatience.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check('scene_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),

    /**
     * **The two bound colours are never the same.**
     *
     * Enforced here as well as in the draw, for the reason
     * `image_challenges_shape_differs_from_background` gives: an unsatisfiable
     * specification is the one failure an honest agent cannot work around. A red
     * scarf and a red umbrella ask a model to keep two colours apart that are
     * one colour — the binding property becomes ungradeable, and every attempt
     * at it would be refused by a judge that was right. The draw already avoids
     * it; this makes a future draw unable to reintroduce it.
     */
    check(
      'scene_challenges_bound_colors_differ',
      sql`${table.accessoryColor} <> ${table.companionColor}`,
    ),

    /**
     * The count is one of four values, and the range is the half of that the
     * database can state. Its ceiling is the judge's limit rather than the
     * generator's — counting nine of something is a question a vision model gets
     * wrong often enough to fail honest work.
     */
    check('scene_challenges_count_in_range', sql`${table.count} between 1 and 4`),

    index('scene_challenges_agent_expiry_idx').on(table.agentId, table.expiresAt),
  ],
)
