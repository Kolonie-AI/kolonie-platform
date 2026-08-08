import { sql } from 'drizzle-orm'
import { check, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { ProposalAuthor, ProposalStatus, ProviderClaimMethod } from '@kolonie-ai/core'

/**
 * A provider that has proved it is the provider (`#548`).
 *
 * Proof is ordinary and the Colony already does both forms: a token at a
 * well-known path on the provider's own domain, or a mail from an address at it.
 * Nothing here grants an edit — see {@link entryProposals}, which is the only
 * thing a claim opens.
 *
 * **Keyed by provider and not by kind.** A claim is about who runs the service,
 * and `github.com` is one counterparty however many kinds of account it offers.
 */
export const providerClaims = pgTable('provider_claims', {
  provider: text('provider').primaryKey(),
  method: text('method').$type<ProviderClaimMethod>().notNull(),
  /** How to reach them about their own entry. Required: a claim with no contact is a dead end. */
  contact: text('contact').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
})

/**
 * A proposed change to an entry (`#548`, reviewed by `#549`).
 *
 * **One table for citizens and for claimed providers**, because `#548` requires
 * a provider's change to go through the same review a citizen's contribution
 * does. Two queues would be two standards within a month, and the second one
 * would be the one with a paying counterparty behind it.
 *
 * **A proposal is never applied on arrival.** `proposed` is the shape somebody
 * wants the entry to become, held as `jsonb` and validated when it is reviewed
 * rather than when it is filed: an entry shape that changes should not orphan a
 * queue of pending proposals.
 */
export const entryProposals = pgTable(
  'entry_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    author: text('author').$type<ProposalAuthor>().notNull(),
    proposed: jsonb('proposed').$type<Record<string, unknown>>().notNull(),
    note: text('note'),
    status: text('status').$type<ProposalStatus>().notNull().default('pending'),
    proposedAt: timestamp('proposed_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check(
      'entry_proposals_author_is_known',
      sql`${table.author} in ('citizen', 'claimed-provider')`,
    ),
    check(
      'entry_proposals_status_is_known',
      sql`${table.status} in ('pending', 'accepted', 'refused')`,
    ),
    /**
     * A decided proposal has a date and a pending one has none.
     *
     * In SQL as well as in the write path, because `#549`'s queue is *proposals
     * nobody has read* and a decided row with no date would sit in it forever.
     */
    check(
      'entry_proposals_decided_has_a_date',
      sql`(${table.status} = 'pending' and ${table.decidedAt} is null)
          or (${table.status} <> 'pending' and ${table.decidedAt} is not null)`,
    ),
  ],
)
