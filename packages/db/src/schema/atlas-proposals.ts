import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import {
  ACCOUNT_PROVIDER_MAX_LENGTH,
  PROPOSAL_REASON_MAX_LENGTH,
  ProposalDecisionSchema,
  ProposalSourceSchema,
} from '@kolonie-ai/core'

const providerMax = sql.raw(String(ACCOUNT_PROVIDER_MAX_LENGTH))
const reasonMax = sql.raw(String(PROPOSAL_REASON_MAX_LENGTH))
const SOURCES = ProposalSourceSchema.options
const DECISIONS = ProposalDecisionSchema.options

/**
 * One proposal queue, three doors (`#600`).
 *
 * ## Why this is a table and not a column on `provider_recipes`
 *
 * A proposal is a question about a provider the catalogue may never hold. Giving
 * it a recipe row would mean the Atlas contains an entry for every provider
 * anybody ever mentioned, kept out of sight by a status — and the first surface
 * that forgot the filter would publish somebody's suggestion as a listing.
 *
 * ## Why it is not `entry_proposals`
 *
 * That table (`#548`) holds *changes to an entry that exists*, keyed by
 * `(kind, provider)` and carrying a field diff. This is *should this provider be
 * on the map at all*, where there is no entry, no kind and nothing to diff. One
 * table for both would leave half its columns meaningless on every row.
 *
 * ## One row per provider
 *
 * The second party to ask finds the row already there, which is what makes *how
 * many different parties have asked for this* answerable at all. It is also the
 * reason no proposer is named here: the count comes from `account_wishes` under
 * its aggregate floor, and this table holds the question rather than the asker.
 */
export const atlasProposals = pgTable(
  'atlas_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    provider: text('provider').notNull(),

    /** Which door it first came through. Never who came through it. */
    source: text('source').notNull(),

    /** Why, in the proposer's own words. The part all three doors already collect. */
    why: text('why'),

    status: text('status').notNull().default('pending'),

    /**
     * What the proposer is told, on a refusal.
     *
     * **Required on a refusal and forbidden otherwise**, by the constraint
     * below. *No* with no reason teaches nothing and invites the same proposal
     * next month; an accepted entry needs no sentence, because appearing on the
     * map is the answer.
     */
    decidedReason: text('decided_reason'),

    /** The entry it turned out to be, on a merge. Required on one, forbidden otherwise. */
    mergedInto: text('merged_into'),

    proposedAt: timestamp('proposed_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /** One row per provider: see the header. */
    uniqueIndex('atlas_proposals_one_per_provider').on(table.provider),

    /** The queue reads pending, oldest first. */
    index('atlas_proposals_pending').on(table.status, table.proposedAt),

    check('atlas_proposals_provider_length', sql`length(${table.provider}) <= ${providerMax}`),
    check(
      'atlas_proposals_source_is_known',
      sql`${table.source} in (${sql.raw(SOURCES.map((one) => `'${one}'`).join(', '))})`,
    ),
    check(
      'atlas_proposals_status_is_known',
      sql`${table.status} in (${sql.raw(DECISIONS.map((one) => `'${one}'`).join(', '))})`,
    ),
    check(
      'atlas_proposals_why_length',
      sql`${table.why} is null or length(${table.why}) <= ${reasonMax}`,
    ),

    /**
     * **A refusal says why, and nothing else carries a reason.** The same shape
     * `provider_recipes_refusal_says_why` has one table over, for the same
     * reason: a column that only means something in one state is a column that
     * will be filled in another unless the database refuses.
     */
    check(
      'atlas_proposals_refusal_says_why',
      sql`(${table.status} = 'refused' and ${table.decidedReason} is not null
           and length(${table.decidedReason}) <= ${reasonMax})
          or (${table.status} <> 'refused' and ${table.decidedReason} is null)`,
    ),

    /** The same pair, one outcome along: a merge names what it merged into. */
    check(
      'atlas_proposals_merge_names_its_entry',
      sql`(${table.status} = 'merged' and ${table.mergedInto} is not null)
          or (${table.status} <> 'merged' and ${table.mergedInto} is null)`,
    ),

    /** A decided row has a date and a pending one has none. */
    check(
      'atlas_proposals_decided_has_a_date',
      sql`(${table.status} = 'pending' and ${table.decidedAt} is null)
          or (${table.status} <> 'pending' and ${table.decidedAt} is not null)`,
    ),
  ],
)
