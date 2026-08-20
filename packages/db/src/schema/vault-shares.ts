import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { VAULT_KEY_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * One vault entry a citizen has handed to its operator, for a bounded time (`#1439`).
 *
 * ## Why this exists at all
 *
 * Both channels that carried a secret between a citizen and its person had a
 * hundred per cent failure rate over their whole lifetime, measured in
 * production on 2026-08-20: `agent_handovers` — the agent's direction — was
 * opened forty-two times and read **zero** times; `operator_drops` — the
 * person's direction — was opened seven times and filled **zero** times. Agents
 * were trying: thirty-one handovers in the last week of it, by three citizens.
 * Nothing ever arrived at the far end, once, since either shipped.
 *
 * The vault, meanwhile, is the most-used durable surface citizens have: 155
 * entries across 14 citizens, and it works. So the secret stops moving and the
 * *reach* moves instead. `#1437` is the epic; this table is the mechanism.
 *
 * ## A sealed copy, and the `agent_vault` row is never touched
 *
 * `#1437` decision 3. The obvious design is a flag on `agent_vault`, and it is
 * wrong for a reason that only shows up at the end: a vault entry is sealed
 * under the **citizen's** API key and the Colony holds only a SHA-256 of it
 * (`vault-crypto.ts`), so a share that ended while the citizen was asleep could
 * never be re-sealed back to the citizen's key. The Colony would be holding a
 * row it could not restore and the citizen could not open. Copying means that
 * state cannot arise: the original is untouched throughout, and ending a share
 * destroys a copy rather than trying to put something back.
 *
 * ## Sealed under the Colony's key, and said out loud
 *
 * `sealed_value` uses `OPERATOR_DROP_SEALING_KEY`, the way `account_slots`
 * already does — decision 5, and no new secret to provision. This is the one
 * place the Colony *can* read a citizen's secret, for as long as a share is
 * open, and it is not a loophole in D-043: a person has no key of their own, and
 * if they had one the Colony would be holding that too. It is a citizen
 * deciding, per entry, to spend the promise for a few days. What makes that a
 * choice rather than a betrayal is that it is visible — see
 * `VaultShareSchema` in core, which every read of an entry carries.
 */
export const vaultShares = pgTable(
  'vault_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Cascade, for `agent_vault`'s reason exactly: a copy of a secret belonging
     * to a citizen that no longer exists is ciphertext nobody — including the
     * Colony — could inspect to discover it had been left behind, which is the
     * leftover `erasure.md` §4 rules out.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The entry's plaintext name, and **not a foreign key to `agent_vault`**.
     *
     * The name is what the citizen already uses and what the associated data
     * binds the copy to, so it has to be here in the clear either way. A
     * reference on top of it would make deleting a vault entry cascade away the
     * record that a person had been able to read it — which is the one thing
     * about a share that ought to outlive the entry.
     */
    vaultKey: varchar('vault_key', { length: VAULT_KEY_MAX_LENGTH }).notNull(),

    /**
     * The citizen's own sentence, shown to the operator above the value.
     *
     * **Written by the citizen** (`#1437` decision 2), which reverses the rule
     * `packages/core/src/operator/handover.ts` states for a handover. The
     * anti-injection argument there was about a sentence arriving beside a
     * secret *with no other context*; a share hangs on a conversation the
     * citizen is visibly writing in, so the operator can already see whose words
     * these are. Where there is no such thread — `kolonie.accounts.handoff` —
     * the Colony goes on writing the sentence.
     */
    purpose: text('purpose').notNull(),

    /**
     * The copy, sealed under the Colony's key. Null once the share has ended.
     *
     * Nulled by `unshare` and by the expiry sweep, and the read path does not
     * depend on either having run: an expired row answers as no share on its
     * own timestamp.
     */
    sealedValue: text('sealed_value'),

    /** The description, sealed in the same envelope under its own scope. */
    sealedDescription: text('sealed_description'),

    /**
     * What the operator wrote back — a billing PIN, a recovery code, a note.
     *
     * Sealed like the value, empty until they write, and handed to the citizen
     * exactly once, by `unshare`. **Never merged into the entry** (`#1437`
     * decision 4): the Colony cannot seal to the citizen's key, so it could not
     * write the vault even if that were wanted, and a design that pretended
     * otherwise would need conflict resolution for a case nobody can resolve.
     */
    operatorAddition: text('operator_addition'),

    sharedAt: timestamp('shared_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /**
     * Seven days by default, thirty at most (`#1437` decision 6).
     *
     * Extended rather than re-created when a citizen shares something already
     * shared, which is why the index below is on open rows only.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** When the citizen took it back, or the operator handed it back early. */
    takenBackAt: timestamp('taken_back_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * One open share per entry, and the partial predicate is `taken_back_at`
     * alone rather than *neither expired nor taken back*.
     *
     * Expiry is a comparison against `now()` and therefore not immutable, so it
     * cannot be in an index predicate at all. That turns out to be the right
     * shape anyway: an expired share that nobody has ended is the row a citizen
     * re-sharing the same entry should be **extending**, and a predicate that
     * excluded it would silently mint a second row for one entry — which is the
     * thing this index exists to make impossible.
     */
    uniqueIndex('vault_shares_one_open_per_key')
      .on(table.agentId, table.vaultKey)
      .where(sql`taken_back_at is null`),

    /** The sweep's path: rows past their window that still hold something. */
    index('vault_shares_expiry_idx').on(table.expiresAt),
  ],
)
