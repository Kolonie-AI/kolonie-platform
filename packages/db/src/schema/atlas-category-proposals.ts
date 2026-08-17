import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  ACCOUNT_PROVIDER_MAX_LENGTH,
  ATLAS_CATEGORY_PROPOSAL_WHY_MAX_LENGTH,
  ATLAS_CATEGORY_STANDFIRST_MAX_LENGTH,
  ATLAS_CATEGORY_TITLE_MAX_LENGTH,
  AtlasCategoryProposalStatusSchema,
} from '@kolonie-ai/core'
import { atlasCategories } from './atlas-categories.js'

const providerMax = sql.raw(String(ACCOUNT_PROVIDER_MAX_LENGTH))
const whyMax = sql.raw(String(ATLAS_CATEGORY_PROPOSAL_WHY_MAX_LENGTH))
const titleMax = sql.raw(String(ATLAS_CATEGORY_TITLE_MAX_LENGTH))
const standfirstMax = sql.raw(String(ATLAS_CATEGORY_STANDFIRST_MAX_LENGTH))
const STATUSES = AtlasCategoryProposalStatusSchema.options

/**
 * What a model thinks a provider is, waiting for somebody to agree (`#1106`).
 *
 * ## Why a queue and not a write
 *
 * `#1102` left the n:m table populated with exactly the shelf every entry
 * already had, and said why: *shipping a migration that guesses which providers
 * are also knowledge-docs would put guesses in front of readers with nobody
 * having reviewed one.* The same sentence rules out a model writing the rows
 * directly. So the model proposes and a maintainer accepts, and this table is
 * the gap between those two acts — which is the only place the review can
 * happen, because after the join row is written there is nothing left to review.
 *
 * ## Why it is not `entry_proposals`
 *
 * That table holds a field diff against an entry that exists. Half of this
 * queue's rows are providers whose kind reaches no shelf at all (`#1096`), where
 * there is no entry to diff and the answer may be a category row that does not
 * exist yet. A diff cannot express *make this shelf, then put it there*.
 *
 * ## What a row may say, and what it may not
 *
 * The two shapes are `AtlasCategoryProposalShapeSchema`'s, and the constraints
 * below are that schema written a second time in SQL — a proposal is read back
 * by a maintainer and acted on by a transaction, and a row inserted at a psql
 * prompt reaches both without passing through any Zod. **Nothing here can name a
 * new top category**: `new-sub` requires a parent, and the parent is a foreign
 * key into a table whose own composite key refuses a third level.
 */
export const atlasCategoryProposals = pgTable(
  'atlas_category_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The pair the proposal is about. Not a recipe id: half the queue has no recipe row. */
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),

    /** `existing` or `new-sub`. There is deliberately no third. */
    shape: text('shape').notNull(),

    /**
     * The shelf proposed.
     *
     * **No foreign key, and that is the point of the two shapes.** On `existing`
     * this slug is in `atlas_categories` and on `new-sub` it must not be, so a
     * reference would be right for half the rows and wrong for the other half.
     * Which one it is is checked when a maintainer accepts, against the table as
     * it stands then rather than as it stood when the model read it.
     */
    categorySlug: text('category_slug').notNull(),

    /**
     * The top category a new shelf would hang from. Null on `existing`.
     *
     * The reference is what makes decision 3 hold at the row: a parent that is
     * not a category cannot be written, and `atlas_categories`' own generated
     * composite key is what refuses a parent that is itself a sub category when
     * the row is finally inserted.
     */
    parentSlug: text('parent_slug').references(() => atlasCategories.slug),

    /** What a reader would see. Null on `existing`, where the shelf already has both. */
    title: text('title'),
    standfirst: text('standfirst'),

    /** Why this provider belongs there, in the model's words, for whoever decides. */
    why: text('why').notNull(),

    /**
     * The walks it was read from (`#1106`, decision 4).
     *
     * **Non-empty, checked here as well as in the schema.** A proposal citing no
     * walk is a guess, and a maintainer looking at a queue cannot tell one from a
     * reading unless the citation is a column rather than a habit.
     */
    walks: jsonb('walks').$type<readonly string[]>().notNull(),

    /**
     * Which model wrote it, as configuration named it.
     *
     * Read from the runner's own configuration at write time, never written into
     * a file here (`#207`): the queue has to be able to say *this batch came from
     * the model we changed on Tuesday*, and a repository has no business carrying
     * the name.
     */
    model: text('model').notNull(),

    status: text('status').notNull().default('open'),

    /** What a maintainer said, on a decline. Required on one, forbidden otherwise. */
    decidedReason: text('decided_reason'),

    proposedAt: timestamp('proposed_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * **At most one open proposal per pair** (`#1106`, decision 6).
     *
     * A partial index rather than an application check, because the runner is a
     * loop that may be running twice: two ticks reading the same provider a
     * second apart would each find no open proposal and each write one, and a
     * maintainer would be asked the same question twice with no way to tell which
     * answer the accept path would use.
     */
    uniqueIndex('atlas_category_proposals_one_open')
      .on(table.kind, table.provider)
      .where(sql`${table.status} = 'open'`),

    /**
     * **A pairing is settled once** (`#1106`, decision 7). A decline is recorded
     * against the pairing rather than against the proposal, so the row that holds
     * the *no* is also what stops the question being asked again.
     */
    uniqueIndex('atlas_category_proposals_once_per_pairing').on(
      table.kind,
      table.provider,
      table.categorySlug,
    ),

    /** The queue reads open, oldest first. */
    index('atlas_category_proposals_open').on(table.status, table.proposedAt),

    check('atlas_category_proposals_kind_length', sql`length(${table.kind}) between 3 and 32`),
    check(
      'atlas_category_proposals_provider_length',
      sql`length(${table.provider}) <= ${providerMax}`,
    ),
    check(
      'atlas_category_proposals_slug_is_a_slug',
      sql`${table.categorySlug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.categorySlug}) <= 64`,
    ),
    check(
      'atlas_category_proposals_status_is_known',
      sql`${table.status} in (${sql.raw(STATUSES.map((one) => `'${one}'`).join(', '))})`,
    ),
    check(
      'atlas_category_proposals_why_says_something',
      sql`length(${table.why}) between 1 and ${whyMax}`,
    ),

    /**
     * **The two shapes, and no row between them.** A `new-sub` missing its parent
     * would be a new top category; an `existing` carrying a title would be a
     * rename of a shelf somebody else wrote. Both are refused rather than ignored
     * by whoever reads the row next.
     */
    check(
      'atlas_category_proposals_shape_is_whole',
      sql`(${table.shape} = 'existing' and ${table.parentSlug} is null
           and ${table.title} is null and ${table.standfirst} is null)
          or (${table.shape} = 'new-sub' and ${table.parentSlug} is not null
              and length(${table.title}) between 1 and ${titleMax}
              and length(${table.standfirst}) between 1 and ${standfirstMax})`,
    ),

    /** A proposal cites at least one walk, or it is not a proposal. */
    check(
      'atlas_category_proposals_cites_a_walk',
      sql`jsonb_typeof(${table.walks}) = 'array' and jsonb_array_length(${table.walks}) >= 1`,
    ),

    /**
     * **A decline says why, and nothing else carries a reason.** The shape
     * `atlas_proposals_refusal_says_why` already has one table over: accepting
     * needs no sentence, because the shelf appearing on the entry is the answer.
     */
    check(
      'atlas_category_proposals_decline_says_why',
      sql`(${table.status} = 'declined' and ${table.decidedReason} is not null
           and length(${table.decidedReason}) between 1 and ${whyMax})
          or (${table.status} <> 'declined' and ${table.decidedReason} is null)`,
    ),

    /** A decided row has a date and an open one has none. */
    check(
      'atlas_category_proposals_decided_has_a_date',
      sql`(${table.status} = 'open' and ${table.decidedAt} is null)
          or (${table.status} <> 'open' and ${table.decidedAt} is not null)`,
    ),
  ],
)
