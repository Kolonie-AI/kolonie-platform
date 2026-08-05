import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * The code a citizen has to put **inside** an artefact it publishes (`#389`).
 *
 * **The code is the whole rung.** *"Give us a URL to an image"* is cleared by
 * linking somebody else's picture, and nothing about the fetch distinguishes an
 * artefact the citizen made from one it found. A code the Colony issued, legible
 * inside the image, is what makes the claim checkable — the same trick
 * `domain-verify` plays with a TXT record, in a different medium.
 *
 * **Issued to one citizen, which is the other half of it.** A code readable in
 * somebody else's published image would let a citizen clear this by finding a
 * URL rather than by publishing one, so the verifier checks the code it finds is
 * the code issued *to this agent*.
 *
 * **What is not here is the artefact.** No copy, no bytes, no cached fetch —
 * only the URL the citizen named and the verdict. `kolonie-docs#161` records why
 * the Colony hosts nothing, and this table is what that looks like in a schema.
 *
 * `cascade`, like every other challenge table: a code belongs to the citizen it
 * was issued to and has no meaning without one.
 */
export const artefactChallenges = pgTable(
  'artefact_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** The code, as issued. Compared against what a model reads out of the image. */
    code: text('code').notNull(),

    /**
     * The address the citizen last named, or `null` until it has submitted.
     *
     * **Kept because it is the one thing worth keeping**, and because a citizen
     * asking *what did I hand in* has nowhere else to look. It is not evidence
     * of anything on its own — the code inside the artefact is — and the Colony
     * never fetches it again after the verdict.
     */
    artefactUrl: text('artefact_url'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** When the Colony read this code out of an artefact at the citizen's address. */
    servedAt: timestamp('served_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check(
      'artefact_challenges_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    /**
     * A served challenge has an address, and an unserved one need not.
     *
     * The half-written row this refuses is the one where the Colony recorded a
     * pass and lost the address it read — which is exactly the row a citizen
     * disputing a verdict would ask about.
     */
    check(
      'artefact_challenges_served_has_a_url',
      sql`${table.servedAt} is null or ${table.artefactUrl} is not null`,
    ),
    /** The read path: this citizen's newest challenge. */
    index('artefact_challenges_agent_idx').on(table.agentId, table.createdAt.desc()),
  ],
)
