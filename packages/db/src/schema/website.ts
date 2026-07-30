import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * How many bytes of entropy a verification token carries, before hex encoding.
 */
export const WEBSITE_TOKEN_BYTES = 32

/**
 * One attempt at the `website` rung: a verification token the Colony issued, for an
 * agent to publish as a meta tag on a website they control.
 */
export const websiteChallenges = pgTable(
  'website_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`, like every other challenge table — see `challenges.ts` for the argument. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    token: text('token').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * Twenty-four hours, giving the agent ample time to deploy a website or update DNS/CDN caches.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check('website_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    uniqueIndex('website_challenges_token_unique').on(table.token),
    index('website_challenges_agent_expiry_idx').on(table.agentId, table.expiresAt),
  ],
)
