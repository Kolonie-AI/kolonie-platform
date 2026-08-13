import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import type { ProviderBriefingClaim } from '@kolonie-ai/core'

/**
 * The Colony's own write-up of one provider, regenerated from the walks of it
 * (`#831`).
 *
 * `task_briefings` is the shape this mirrors, down to the nullable pair and the
 * dirty flag, and every argument on that table holds here unchanged: one row per
 * subject rather than one per generation, because a briefing is a current
 * statement and nothing ever read an old one; `claims` defaulting to empty with
 * `written_at` null, because the row is created by the dirty-marking and *the
 * Colony has not written this up yet* must not read the same as *nobody has
 * walked this*.
 *
 * **What differs is the key, and it is the only thing that differs.** A task is
 * a row with a uuid; a provider is a pair of text columns that no table owns —
 * `AccountKindSchema` takes any slug and `provider` is free text on purpose, so
 * that a provider the Colony has never heard of is not a migration (see
 * `account_walks`). So the key is the pair itself and there is no foreign key to
 * hang it on. That is the same arrangement `atlas_figures` readers already work
 * in, and `canonicalProvider` is what a reader resolves through before it gets
 * here.
 *
 * **The empty briefing is no row at all** (`#611`): a synthesis that produces
 * nothing deletes the row rather than storing an empty one, so the queue does not
 * carry providers there is nothing to say about, and a reader's *no briefing* and
 * *a briefing saying nothing* are the same answer because they are the same fact.
 */
export const providerBriefings = pgTable(
  'provider_briefings',
  {
    /**
     * The provider this is about, and — with {@link kind} — the primary key.
     *
     * **Text, and free**, for `account_walks`' reason: a kind the Colony has not
     * enumerated must not be a migration, and the walks this is written from are
     * keyed the same way. There is nothing to reference: no table owns the pair,
     * which is why a rename is a row in `atlas_renames` rather than an update
     * here.
     *
     * Held canonical by the write path — `canonicalProvider` resolves before
     * anything reads or writes — rather than by a constraint, exactly as every
     * other provider-keyed table in the schema does it.
     */
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),

    /**
     * The claims, each with the walks behind it. See `ProviderBriefingClaimSchema`.
     *
     * Never empty on a stored row, which is the one place this departs from
     * `task_briefings.claims`: an empty synthesis deletes instead of writing, so
     * an empty array here means the row was created by the dirty-marking and no
     * synthesis has run yet — the state `written_at` names.
     */
    claims: jsonb('claims')
      .$type<ProviderBriefingClaim[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** The model that wrote it, as configured then. Null until one has. */
    model: text('model'),

    /** When it was written. Null until it has been. */
    writtenAt: timestamp('written_at', { withTimezone: true, mode: 'string' }),

    /**
     * Whether the walks have changed since the briefing was written.
     *
     * The same cost control `task_briefings.dirty` is, and against the same
     * failure: a provider that collects a hundred walks must not cost a hundred
     * syntheses. Set when a walk's prose is approved — inside
     * `recordWalkProseModeration`, so no write path can approve prose and forget
     * to mark it — and consumed by a slower tick.
     *
     * A *may* rather than a *did*, as there: a redundant synthesis costs one
     * model call, a missed one leaves a citizen attempting a provider on the
     * strength of a wall that was removed.
     */
    dirty: boolean('dirty').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One briefing per provider by construction. The pair is the whole identity
     * of the subject, nothing references a briefing, and a surrogate id would buy
     * only the chance of two rows for one provider.
     */
    primaryKey({ columns: [table.kind, table.provider] }),
    check('provider_briefings_claims_is_array', sql`jsonb_typeof(${table.claims}) = 'array'`),
    /**
     * A written briefing names the model that wrote it, and an unwritten one
     * names neither — `task_briefings_written_at_matches_model`'s check, for its
     * reason: either half alone means a writer died between two fields, and the
     * row is then unreadable to anything asking *who wrote this and when*.
     */
    check(
      'provider_briefings_written_at_matches_model',
      sql`(${table.writtenAt} is null) = (${table.model} is null)`,
    ),
    /** The synthesis runner's queue: everything stale, oldest first. */
    index('provider_briefings_dirty_idx')
      .on(table.createdAt)
      .where(sql`${table.dirty}`),
  ],
)
