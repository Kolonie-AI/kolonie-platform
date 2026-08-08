import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { paymentObserver } from './enums.js'

/**
 * Every SOL transfer the Colony has observed arriving at its own wallet,
 * attributed or not — D-106 (`#503`).
 *
 * **This is `deposits` with the custody removed.** There, one address per
 * sponsor and a sealed key per address made attribution a property of the
 * *recipient*; here there is one address, the Colony's own, and attribution is a
 * property of the **sender** — matched against the address a citizen proved it
 * controls at the `solana-wallet` rung. Nothing in this table implies the Colony
 * holds a key to anything except its own wallet, and after `#506` nothing in the
 * schema does.
 *
 * **The unattributable ones are here too, with a reason**, for the reason the
 * refused deposits were: money that arrived and became nothing, with no visible
 * record, is the single worst thing this path can do to whoever sent it. A
 * quarantined row is a maintainer's queue, not a log line.
 */
export const colonyPayments = pgTable(
  'colony_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The transaction signature, and the whole of the idempotency.
     *
     * A unique constraint rather than a check in code, for the reason
     * `deposits_signature_unique` is one: the webhook and the reconciliation
     * read the same transfers, so the second write is the expected case and
     * Postgres is the only participant that sees both.
     */
    signature: varchar('signature', { length: 120 }).notNull(),

    /**
     * The address the money came from.
     *
     * **Kept on every row, attributed or not.** On an attributed row it is how
     * the attribution can be re-checked years later without the challenge table;
     * on a quarantined one it is the only thing a maintainer has to work with —
     * and *"whoever sent this can be asked to prove it"* is exactly what a
     * sender address is for.
     */
    sender: varchar('sender', { length: 64 }).notNull(),

    /**
     * Which channel saw this arrival first (`kolonie-infra#95`).
     *
     * **The Colony watches its wallet twice and could not say which one
     * worked.** `kolonie-platform#503` set the criterion — the reconciliation
     * alone must be sufficient, a dead webhook must not stop payments being
     * recognised — and left it readable only from a journal line that rotates
     * away. `kolonie-infra#73` records the webhook registered, correctly
     * authenticated and never seen delivering, which is why the pass runs four
     * times an hour; that has been an assumption for a week.
     *
     * **First, not only.** Both channels read the same transfers and the second
     * write is the expected case — `onConflictDoNothing` on the signature means
     * whichever arrives first is what this records, which is exactly the
     * question being asked.
     *
     * **Nullable, and null is a fact rather than a gap**: recorded before the
     * Colony kept this. A query for *has the webhook ever delivered* excludes
     * those rather than mistaking them for a channel.
     */
    observedBy: paymentObserver('observed_by'),

    /**
     * The Colony wallet it arrived at.
     *
     * Recorded rather than assumed, because the address is a deploy-time value
     * and a wallet that is rotated leaves rows behind that were true of the old
     * one. A payment whose recipient is not the current wallet is a fact worth
     * being able to see rather than a row that quietly reads as current.
     */
    recipient: varchar('recipient', { length: 64 }).notNull(),

    /** What arrived, in lamports. `bigint` for the reason the ledger uses one. */
    lamports: bigint('lamports', { mode: 'number' }).notNull(),

    /**
     * Whose payment this is, once it has been attributed.
     *
     * `set null`: an erased citizen's payment stays on record because it is the
     * Colony's own income, and `erasure.md` does not promise that money the
     * Colony received disappears — only that what the Colony knows about the
     * citizen does. Which is why `attributed_at` and this column are checked
     * separately below rather than together.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),

    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /** When the sender was matched to a citizen. Null on a quarantined row. */
    attributedAt: timestamp('attributed_at', { withTimezone: true, mode: 'string' }),

    /**
     * Why it could not be attributed — `PaymentQuarantineSchema` in core.
     *
     * Text rather than an enum, on the rule `deposits.rejection` already
     * follows: the vocabulary is core's and a second copy in the database is a
     * migration every time a reason is added.
     */
    quarantine: text('quarantine'),

    /**
     * When a maintainer settled a quarantined row, and what they did.
     *
     * **Resolving is a note and never a re-attribution.** Money that arrived
     * from an address nobody proved they control cannot be given to a citizen on
     * the strength of somebody saying it was theirs — that is the sender
     * having to be believed, which is the failure per-sponsor addresses existed
     * to remove and which D-106 removes by telling the sponsor beforehand. What
     * a maintainer can do is send it back, keep it, or leave it; what they must
     * do is say which.
     */
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    resolution: text('resolution'),
  },
  (table) => [
    uniqueIndex('colony_payments_signature_unique').on(table.signature),
    /**
     * Attributed or quarantined, never both and never neither. A row with
     * neither is a payment nobody decided about, which is the state this table
     * exists to make impossible.
     */
    check(
      'colony_payments_attributed_xor_quarantined',
      sql`(${table.attributedAt} is null) <> (${table.quarantine} is null)`,
    ),
    /**
     * A citizen may only hang off an attributed row. The reverse is not
     * required: erasure nulls the column and the attribution stays true.
     */
    check(
      'colony_payments_agent_only_when_attributed',
      sql`${table.agentId} is null or ${table.attributedAt} is not null`,
    ),
    /** A resolution belongs to a quarantined row and arrives with its note. */
    check(
      'colony_payments_resolution_complete',
      sql`(${table.resolvedAt} is null and ${table.resolution} is null)
          or (${table.resolvedAt} is not null and ${table.resolution} is not null
              and ${table.quarantine} is not null)`,
    ),
    check('colony_payments_lamports_non_negative', sql`${table.lamports} >= 0`),
    /** The sponsor's own payments, newest first — what `#504` matches an invoice against. */
    index('colony_payments_agent_idx').on(table.agentId, table.observedAt),
    /**
     * The maintainer's queue: everything quarantined and not yet settled.
     *
     * Partial, because that is the only version of this question anybody asks —
     * and a quarantined row nobody has resolved is money the Colony is sitting
     * on, which should be cheap to find and impossible to lose.
     */
    index('colony_payments_open_quarantine_idx')
      .on(table.observedAt)
      .where(sql`${table.quarantine} is not null and ${table.resolvedAt} is null`),
  ],
)
