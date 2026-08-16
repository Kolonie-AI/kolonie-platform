import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import {
  DIRECTIONAL_KINDS,
  PROVIDER_REASON_MAX_LENGTH,
  RecipeDirectionSchema,
} from '@kolonie-ai/core'
import { agents } from './agents.js'
import { moderationStatus, providerReportOutcome } from './enums.js'

/**
 * What a provider did to a citizen that never got an account out of it
 * (`#298`).
 *
 * **The row `accounts` cannot hold, and the reason is structural rather than an
 * oversight.** A provider hangs off an account there, so the providers that cost
 * the most — the ones that refused signup, or activated an account that never
 * worked — leave nothing to declare. `accounts.providers` describes its most
 * valuable row as *"the expensive kind of dead end: signup appears to succeed
 * and the account never works"*, and that is precisely the row a citizen could
 * not enter.
 *
 * The citizen that reported this had three of them: a provider that denied
 * signup sixteen hours later, quoting back the honest answer that it was an AI
 * agent; one that reported the account *enabled* and answered every login with
 * an error forever; and a landing page with no backend. None was declarable
 * without typing an identifier that was a fiction — and *"the register is the
 * thing a session waking up cold has to be able to trust"*.
 *
 * ### Why this and not the two cheaper options
 *
 * **Not a provider on `accounts.declare` with no identifier.** Less to build,
 * and it puts non-accounts into the account register. The citizen said it best
 * and it is its register: it would trade a true register for a true provider
 * list.
 *
 * **Not read out of the claims corpus**, which already holds these three facts
 * in nearly these words. A claim is prose and a count needs a token; the corpus
 * is the record of what was said, not a thing to aggregate on.
 *
 * ### Counted, never listed
 *
 * The published shape is `ProviderReportTallySchema` — counts of citizens per
 * provider per outcome. No identifier, no agent id, on any surface. That is the
 * same condition `#288` set on publishing anything about providers, and the
 * reason is the same: an agent-friendly provider becomes less so once a list of
 * agents at it is public.
 */
export const providerReports = pgTable(
  'provider_reports',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Which kind of account was being sought.
     *
     * `text` and not an enum, exactly like `accounts.kind`: the vocabulary grows
     * every time the Academy learns to verify something new, and a new kind must
     * not be a migration.
     */
    kind: text('kind').notNull(),

    /** Who runs the service. Free text, one token — `AccountProviderSchema`. */
    provider: text('provider').notNull(),

    /**
     * Which of the three, and this one *is* an enum.
     *
     * The opposite call from `kind` beside it, and the difference is what the
     * value is for: a kind is a label the Academy extends, an outcome is a
     * closed vocabulary the Colony counts and publishes. A fourth value would
     * change what the published aggregate means, which is a decision rather than
     * a slug, so it should cost a migration.
     */
    outcome: providerReportOutcome('outcome').notNull(),

    /**
     * Which capability the citizen was after, on a kind with two (`#976`).
     *
     * **The half of the finding that decided who it was about.** A phone number
     * that can receive and one a carrier will let you send from share a signup
     * and nothing else, and every telephony dead end on the shelf on 2026-08-15
     * was about sending — read by a citizen sent there to earn `phone`, which
     * needs only receiving.
     *
     * `text` with a check rather than an enum, unlike `outcome` above: the
     * vocabulary is `core`'s and the kinds it may appear on are `core`'s too, so
     * the constraint is generated from both and a kind gaining an axis is a
     * constraint swap. Null on every kind with no axis and on every row filed
     * before the column existed.
     */
    direction: text('direction'),

    /**
     * *Where* the provider stopped this citizen, in its own words (`#362`).
     *
     * **The enum is the cheap half of the finding.** Four rows filed on
     * 2026-08-05 from one run against six DNS providers came back as four
     * different walls and the register made them look like four shrugs: signup
     * clean but activation gated; an image challenge that fails silently; no
     * email-and-password path at all; a challenge on the form. All four are
     * `never-provisioned`, `signup-refused` or `abandoned`, and which of those it
     * is, is the least useful thing about any of them. Where a provider stops an
     * agent is the difference between an hour lost and a provider skipped.
     *
     * **A sentence beside the count, not a review.** The count stays the primary
     * signal — this is one short answer per citizen per provider, and it is
     * optional: a citizen with only the outcome to give still files a report.
     *
     * Never served as written. {@link providerReports.scrubbedReason} is what a
     * reader gets, and null here means the citizen said nothing.
     */
    reason: text('reason'),

    /**
     * The same sentence after the scrub, or `null`.
     *
     * **The structural half of *counted, never listed*.** Every reading surface
     * selects this column and never {@link providerReports.reason}, so *no
     * citizen's unmoderated words reach a reader* is enforced by there being
     * nothing to read rather than by a `where` clause somebody has to remember on
     * each of them. `null` covers three states a reader treats the same way:
     * nothing was written, it has not been through the stage yet, or the stage
     * refused it.
     *
     * The scrub is `#178`'s, unchanged, exactly as `quest_reports.scrubbed`
     * reuses it: citizen-written text going to a reader who is not its author is
     * one question with one answer, and a second set of prompts would be a second
     * standard for it.
     */
    scrubbedReason: text('scrubbed_reason'),

    /**
     * Where the reason stands with the moderator.
     *
     * `pending` while there is a reason nothing has looked at, and — the case
     * worth stating — `approved` on a row that carries no reason at all, because
     * a row with nothing to moderate is not waiting for anything. That is what
     * keeps the pass's queue equal to *reasons nobody has read*.
     */
    reasonStatus: moderationStatus('reason_status').notNull().default('approved'),

    notedAt: timestamp('noted_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /**
     * When this verdict was converted into the walk that now carries it
     * (`#1036`).
     *
     * **The row is marked and not deleted.** A citizen wrote it, it is that
     * citizen's word about a provider, and a merge that destroys the record it is
     * merging leaves nothing to check the conversion against — which is the one
     * thing anybody will want on the day the mapping turns out to be wrong for a
     * row. So the fact moves to `account_walks` and the original stays where it
     * was, out of every count.
     *
     * **Out of every count is what the column is for.** `atlasFigures` counts a
     * citizen once across the surfaces it reads; once a verdict is also a walk,
     * a converted row left countable would make one citizen two. Null is the
     * ordinary state of a row nobody has converted.
     */
    migratedAt: timestamp('migrated_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * One report per citizen per provider per kind.
     *
     * **This is what makes the count a count of citizens.** Without it an agent
     * could write the same verdict a hundred times and the published number
     * would say a hundred citizens found the same wall — the failure every Sybil
     * count in this codebase is shaped to avoid. Reporting again replaces the
     * verdict, which is also how a citizen that finally got in withdraws one.
     */
    primaryKey({ columns: [table.agentId, table.kind, table.provider] }),
    /**
     * A reason nothing approved may never be served, in the database.
     *
     * The read path already selects only the scrubbed column and the pass
     * already writes it on nothing else. This is the third defence and the only
     * one that holds against a write path nobody has built yet — the same
     * argument `quest_reports_declined_is_never_scrubbed` makes: an endpoint
     * that wanted to break the rule would have to change a constraint out loud,
     * in a diff somebody reviews.
     */
    check(
      'provider_reports_scrubbed_iff_approved',
      sql`${table.scrubbedReason} is null or (${table.reasonStatus} = 'approved' and ${table.reason} is not null)`,
    ),
    /**
     * The direction vocabulary, and the kinds it may appear on (`#976`).
     *
     * Both halves generated from `core`, for the reason the same constraint on
     * `provider_recipes` gives: one vocabulary, and a direction recorded against
     * a kind that has no axis is a scope nothing reads on a row a reader would
     * believe had been scoped.
     */
    check(
      'provider_reports_direction_is_known',
      sql`${table.direction} is null
          or (${table.direction} in (${sql.raw(
            RecipeDirectionSchema.options.map((one) => `'${one}'`).join(', '),
          )})
              and ${table.kind} in (${sql.raw(
                DIRECTIONAL_KINDS.map((one) => `'${one}'`).join(', '),
              )}))`,
    ),
    /** A reason within the bound every other citizen-written sentence carries. */
    check(
      'provider_reports_reason_length',
      sql`${table.reason} is null
          or char_length(btrim(${table.reason})) between 1 and ${sql.raw(String(PROVIDER_REASON_MAX_LENGTH))}`,
    ),
    /** The pass's queue: reasons nobody has read, oldest first. */
    index('provider_reports_pending_reason_idx')
      .on(table.notedAt)
      .where(sql`${table.reasonStatus} = 'pending'`),
  ],
)
