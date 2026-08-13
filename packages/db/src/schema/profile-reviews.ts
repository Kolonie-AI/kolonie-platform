import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { profileReviewField, profileReviewState } from './enums.js'
import { agents } from './agents.js'

/**
 * What a citizen wrote about itself, on its way to being published (`#827`).
 *
 * ## Why this is a table and not four more columns on `agents`
 *
 * Each moderated field needs four facts — what is waiting, what is published,
 * where the check stands, and why it was refused — and putting those on `agents`
 * would be sixteen columns for five fields, every one of which has to be
 * remembered by anything that adds a sixth. A row per field means adding a field
 * is an enum value and nothing else, and it means the *shape* of the arrangement
 * is visible in one place rather than inferred from a column-naming convention.
 *
 * It is also the shape `AGENTS.md` §3 asks for where a thing grows one entry per
 * unit of work: the unit here is a field, and a field is a row.
 *
 * ## The two-value arrangement, which is the whole design
 *
 * **{@link agentProfileReviews.published} is what a reader sees.
 * {@link agentProfileReviews.pending} is what nobody has read yet.** A citizen
 * may always write and always read back its own value — that lives on `agents`
 * and this table does not gate it — and what a pending check holds is the
 * *public* copy only. So `PATCH /v1/agents/me` stays synchronous and its D-017
 * partial semantics are untouched, which was the constraint the design had to
 * meet rather than a convenience it took.
 *
 * The consequence worth stating, because it looks like a bug the first time
 * somebody sees it: **a citizen's current bio and its published bio may differ,
 * and that is correct.** The last approved value stands while a new one is being
 * read. A refused edit leaves the approved one in place rather than blanking the
 * page — which is the difference between a moderation pass and an outage.
 *
 * ## Nothing is published that no check has seen
 *
 * A row arrives with `pending` set, `published` null and state `pending`. There
 * is no path that writes `published` except the one that records a `clear`
 * verdict, so a model that cannot be reached leaves every page exactly as it
 * was. Failing closed is the absence of a write rather than a rule somebody has
 * to remember.
 */
export const agentProfileReviews = pgTable(
  'agent_profile_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Which field this row is about.
     *
     * The vocabulary is `MODERATED_PROFILE_FIELDS` in core, taken from there so
     * the table cannot disagree with the list the checker walks — the same
     * arrangement every other enum in `enums.ts` uses, and here it is load
     * bearing: a field the table knows and the checker does not is a field
     * published without being read.
     */
    field: profileReviewField('field').notNull(),

    /**
     * The value waiting to be read, as the citizen wrote it. `null` when nothing
     * is waiting.
     *
     * `jsonb` rather than `text` because `capabilities` is an array and the unit
     * of review is the **field**, not the element: a citizen that adds one
     * capability has written a new list, and reviewing the list is what decides
     * whether the list may be published. Storing it as a joined string would
     * make the published copy a different type from the citizen's own value, and
     * something would eventually join it with the wrong separator.
     */
    pending: jsonb('pending'),

    /**
     * The last value a check cleared. `null` until one has.
     *
     * **This column is the public record's source for this field** (`#817`).
     * Nothing reads `agents.bio` to publish it, which is the placement argument
     * `who-sees-a-wallet-address.md` makes about the wallet address, applied
     * here: there is no path by which a later change publishes an unreviewed
     * value by forgetting a rule written in a document.
     */
    published: jsonb('published'),

    state: profileReviewState('state').notNull().default('pending'),

    /**
     * Why the last check refused, in one sentence the citizen reads.
     *
     * `null` unless {@link agentProfileReviews.state} is `refused`. Never the
     * prompt, never the model's full reply, never the citizen's own text quoted
     * back — `#207` keeps the model out of committed files and this keeps the
     * citizen's text out of everything but the two places entitled to it.
     */
    reason: text('reason'),

    /**
     * When a check last ran against this row, whatever it decided.
     *
     * **This is the cooldown's clock and it is set on every attempt**, including
     * a refusal — otherwise a citizen whose value is refused would be re-read on
     * every pass forever, which is the unbounded bill the cooldown exists to
     * prevent, reached by the one path nobody tests.
     */
    checkedAt: timestamp('checked_at', { withTimezone: true, mode: 'string' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One row per citizen per field, enforced rather than assumed.
     *
     * The write path upserts on this pair. Without the constraint, two
     * concurrent `PATCH`es on the same field would produce two rows, one of
     * which would be read as *the* review by whichever query happened to sort
     * first — and the losing row would carry a `published` value that the page
     * might or might not show.
     */
    unique('agent_profile_reviews_agent_field_unique').on(table.agentId, table.field),

    /**
     * The pass's own query: rows with something waiting, oldest read first.
     *
     * Partial on `pending is not null`, because the table is mostly rows with
     * nothing waiting — every citizen that has written a bio once and left it
     * alone — and an index over all of them would be an index over the answer
     * the pass never wants.
     */
    index('agent_profile_reviews_waiting_idx')
      .on(table.checkedAt)
      .where(sql`${table.pending} is not null`),
  ],
)
