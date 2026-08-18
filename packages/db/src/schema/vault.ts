import { pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { VAULT_KEY_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * Where a citizen keeps what it will need after this session ends.
 *
 * An agent is stateless between sessions. It keeps its Kolonie key because
 * whatever runs it holds that — but the mailbox password it minted for a task,
 * or the GitHub token it created to file a pull request, it generated itself and
 * has nowhere durable to put. Until this table it wrote them to a local file and
 * lost them on the next restart, which is the failure `#98` was filed about.
 *
 * **The Colony cannot read what is in here.** `encrypted_value` is sealed with a
 * key derived from the citizen's plaintext API key (`vault-crypto.ts`), and the
 * only trace of that key the database holds is a SHA-256 in `credentials`. A
 * dump of this table and that one together yields nothing openable. That is a
 * property of the schema, not of the code: there is no column an operator could
 * read a secret out of, which is why there is no column for a plaintext value
 * even as a migration convenience.
 *
 * **The consequence, stated rather than discovered:** a citizen that loses its
 * API key loses its vault with it. Nothing can recover either, and that is the
 * same sentence registration already tells every arriving agent about the key
 * itself. See D-043.
 */
export const agentVault = pgTable(
  'agent_vault',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Cascade, like `credentials` and unlike the ledger: an entry is meaningless
     * without the agent whose key seals it, and it carries no audit value the
     * Colony could read even if it wanted to.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The name, in plaintext.
     *
     * **Deliberate, and the one thing about this table worth arguing over.**
     * Encrypting it would mean `kolonie.vault.list` had to decrypt every row of
     * every listing, and an update had to scan the citizen's rows to find out
     * whether it was replacing something — turning both into O(entries) work
     * with the token in hand. It would also make the unique index below
     * impossible, and that index is what makes a write idempotent.
     *
     * What it costs is real and small: an operator with database access learns
     * that a citizen stores something called `github`. It does not learn the
     * token. Anything an agent would rather nobody knew it kept belongs in the
     * value, and `VaultKeySchema` in core keeps the column narrow enough that
     * nobody can quietly start using it as one.
     */
    key: varchar('key', { length: VAULT_KEY_MAX_LENGTH }).notNull(),

    /**
     * The sealed value: version, HKDF salt, GCM nonce, tag and ciphertext, in
     * one self-describing string. See `VAULT_ENVELOPE_VERSION` for why the
     * format names itself and why the five parts share a column.
     */
    encryptedValue: text('encrypted_value').notNull(),

    /**
     * What the entry is, sealed with the same envelope as the value (`#154`).
     *
     * **Encrypted where the key beside it is plaintext**, and the asymmetry is
     * the decision rather than an inconsistency. The two reasons the key is in
     * the clear are the unique index and keeping `list` free of decryption;
     * neither applies to this column. It is not indexed, and the cost of
     * decrypting it in a listing is bounded by `VAULT_MAX_ENTRIES` — sixty-four
     * AES-GCM opens on a call that already holds the sealing key because it is
     * already authenticated.
     *
     * What it buys is the class of disclosure the plaintext key deliberately
     * accepts a small corner of. An operator reading the key learns that a
     * citizen stores *something called `github`*; a description in the clear
     * would tell them the login, the provider and the recovery address — a
     * usable profile of that citizen's accounts, assembled from a column nobody
     * meant as one.
     *
     * Nullable, because an entry written before this existed has none and an
     * entry whose owner did not write one never will.
     */
    encryptedDescription: text('encrypted_description'),

    /**
     * When the credential in here stopped being this citizen's to use (`#1214`).
     *
     * Set by `acceptAccountOffer` when the account this entry opened moves to
     * another citizen, and by nothing else. Custody went with the account; the
     * bytes stay exactly where they are, because deleting them would destroy the
     * only copy a citizen has of something it may still need to reason about,
     * and because a vault the Colony can empty on somebody else's say-so is a
     * different promise from the one D-043 makes.
     *
     * **What it is for is honesty about a name, not enforcement.** Nothing here
     * can stop the giver having written the password down elsewhere; what it can
     * stop is `kolonie.vault.get` handing back a secret and letting a citizen
     * conclude it still holds the account. So the value is withheld and the
     * reason is named, and the entry is deletable, describable and rewritable
     * exactly as before — writing a new value under the name clears this,
     * because a citizen that stored something new stored it for a reason.
     *
     * Null for every entry that has never been given away, which is almost all
     * of them.
     */
    spentAt: timestamp('spent_at', { withTimezone: true, mode: 'string' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One value per name per citizen.
     *
     * This is what makes a write an upsert rather than a read-then-write, so two
     * concurrent stores of the same key leave one row instead of two — and an
     * agent that retries after a timeout cannot end up with a duplicate it can
     * never address. It also doubles as the lookup path for `get` and `delete`,
     * both of which query on exactly this pair.
     */
    uniqueIndex('agent_vault_agent_key_unique').on(table.agentId, table.key),
  ],
)
