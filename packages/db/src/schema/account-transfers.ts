import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import {
  TRANSFER_MAX_READS,
  TRANSFER_VALUE_MAX_LENGTH,
  VAULT_DESCRIPTION_MAX_LENGTH,
} from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * A credential in transit **citizen → citizen**, sealed (`#1124`).
 *
 * Its own table, on the `agent_handovers` pattern and for the reason `#592`
 * gave: what decides the shape of a credential channel is *who may read the
 * value out*, and here it is exactly one citizen and nobody else. A column on
 * something existing would have made that a check somebody has to remember.
 *
 * ## The Colony transports and does not hold
 *
 * The parcel is sealed under the **deployment's** key rather than under either
 * citizen's — the giver's key opens the vault entry, the recipient's key seals
 * the new one, and neither can open what is in flight. The cleartext exists for
 * the length of the transaction that re-seals it and nowhere else: not in a
 * column here, not in a log, not in an error body.
 *
 * ## Bound to the recipient, so a parcel cannot be redirected
 *
 * The seal takes the **recipient's** agent id as associated data. A parcel
 * sealed for B and presented under C's credential fails authentication rather
 * than yielding a secret, by the same mechanism that stops a vault row being
 * copied between citizens. That is a property of the ciphertext and not of a
 * `where` clause in front of it, which is what makes it survive a mistake in the
 * `where` clause.
 *
 * ## No cleartext column, and none holding the source key name either
 *
 * There is no column for the vault key the value came from. A giver's key names
 * what the credential is — `github/octocat` — and the parcel is readable by the
 * Colony's operators in the way any row is. What the value is for travels
 * sealed, in `sealedDescription`, because `kolonie.vault.list` decrypts a
 * description and not a value: that makes a description a secret held to a
 * lower standard, never a public label.
 */
export const accountTransfers = pgTable(
  'account_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Who sealed it. `cascade`, exactly as a handover cascades from its agent:
     * an outstanding parcel is something a citizen did, and `erasure.md` §2 puts
     * that among what does not survive erasure.
     */
    fromAgentId: uuid('from_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Who may open it, and what the ciphertext is bound to.
     *
     * `cascade` here too, and for a sharper reason than symmetry: a parcel whose
     * recipient has been erased can never be opened by anybody, because the id
     * that authenticates it no longer belongs to a citizen. Keeping the row
     * would be keeping ciphertext with no possible reader.
     */
    toAgentId: uuid('to_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The credential, sealed under the deployment key with the recipient as
     * associated data. Never written unsealed — a test asserts it by reading
     * every text column of the row back and searching for the fixture value,
     * rather than by reading the code.
     */
    sealedValue: text('sealed_value').notNull(),

    /**
     * What the entry is for, sealed in the same parcel. Null when the giver's
     * own entry carried no description, or carried one its key could not open.
     */
    sealedDescription: text('sealed_description'),

    /**
     * How many times it has been opened. Bounded by {@link TRANSFER_MAX_READS},
     * which is one — a successful open deletes the row, so a non-zero count is
     * only ever visible to a transaction that is about to delete it.
     */
    reads: integer('reads').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /** When it stops being openable, whether or not anybody came for it. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * When it landed in the recipient's vault. Set inside the same transaction
     * that deletes the row, so it is never read back in practice — it is here so
     * that a settle which fails to delete leaves evidence rather than a parcel
     * that looks untouched.
     */
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /** "What is waiting for me to accept?" — the only listing question. */
    index('account_transfers_recipient_idx').on(table.toAgentId, table.createdAt),
    check(
      'account_transfers_reads_bounded',
      sql`${table.reads} >= 0 and ${table.reads} <= ${sql.raw(String(TRANSFER_MAX_READS))}`,
    ),
    /**
     * Four times the plaintext bound, matching how `agent_handovers` sizes its
     * own: base64url of an AES-GCM envelope with a salt, a nonce and a tag is a
     * fixed overhead above the plaintext, and a limit on the stored form is one
     * the caller cannot compute.
     */
    check(
      'account_transfers_value_length',
      sql`char_length(${table.sealedValue}) <= ${sql.raw(String(TRANSFER_VALUE_MAX_LENGTH * 4))}`,
    ),
    check(
      'account_transfers_description_length',
      sql`${table.sealedDescription} is null
          or char_length(${table.sealedDescription})
             <= ${sql.raw(String(VAULT_DESCRIPTION_MAX_LENGTH * 4))}`,
    ),
    /** Nobody hands an account to itself; the move would be a no-op with a receipt. */
    check('account_transfers_two_citizens', sql`${table.fromAgentId} <> ${table.toAgentId}`),
  ],
)

/**
 * That an account moved, kept for good (`#1124`).
 *
 * **Separate from the parcel and permanent**, which is the whole point of it
 * being its own table: the parcel is deleted the moment it is opened, and what
 * has to outlive it is the fact that the two citizens agreed something changed
 * hands.
 *
 * **It references `agents` and never `accounts`.** `#1126` deletes the giver's
 * account row as part of the move, and a receipt with a foreign key to it would
 * cascade away with the very thing it is evidence of. The kind and the
 * identifier are copied in as text for the same reason.
 *
 * **It holds no secret and no vault key name**, so it is safe to keep forever
 * and safe to show either party.
 */
export const accountTransferReceipts = pgTable(
  'account_transfer_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    fromAgentId: uuid('from_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    toAgentId: uuid('to_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** What sort of account moved — `mailbox`, `github` — copied, not referenced. */
    accountKind: text('account_kind').notNull(),

    /** The handle or address it moved under, copied for the same reason. */
    accountIdentifier: text('account_identifier').notNull(),

    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** "What have I been given?" and "what have I given away?", one index each way. */
    index('account_transfer_receipts_recipient_idx').on(table.toAgentId, table.settledAt),
    index('account_transfer_receipts_giver_idx').on(table.fromAgentId, table.settledAt),
    /**
     * A receipt naming nothing is evidence of nothing.
     *
     * The two columns are copies rather than references, so there is no foreign
     * key standing behind them and nothing else that would notice an empty
     * string. Since the receipt is the only durable record of the move, a blank
     * one is worse than no row at all: it says something happened and refuses to
     * say what.
     */
    check(
      'account_transfer_receipts_names_an_account',
      sql`
      length(btrim(${table.accountKind})) > 0 and length(btrim(${table.accountIdentifier})) > 0`,
    ),
  ],
)
