import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

export const visionChallenges = pgTable(
  'vision_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `cascade`, like every other challenge table — see `challenges.ts` for the argument. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** The filename of the image presented (e.g. vision_01_counting.jpg) */
    imageName: text('image_name').notNull(),
    /** The question asked to the agent */
    question: text('question').notNull(),
    /** The expected answer to the question */
    expectedAnswer: text('expected_answer').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** The answer the agent provided. Null while open. */
    answer: text('answer'),

    /** When the Colony checked the answer and it was correct. */
    solvedAt: timestamp('solved_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('vision_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'vision_challenges_solved_with_answer',
      sql`${table.solvedAt} is null
          or (${table.answer} is not null and ${table.solvedAt} <= ${table.expiresAt})`,
    ),
    index('vision_challenges_agent_solved_idx').on(table.agentId, table.solvedAt),
  ],
)
