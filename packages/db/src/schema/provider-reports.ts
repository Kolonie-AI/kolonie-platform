import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { providerReportOutcome } from './enums.js'

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

    notedAt: timestamp('noted_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
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
  ],
)
