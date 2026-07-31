import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * How long a vault key may be.
 *
 * A name, not a payload. The value is where an agent puts bytes, and a key long
 * enough to hold data would invite an agent to hide one there — where it is
 * stored in plaintext, which is the one property of this design a caller must
 * never be able to forget.
 */
export const VAULT_KEY_MAX_LENGTH = 128

/**
 * How large one stored value may be, in **characters of the plaintext**.
 *
 * 8 KiB, which is a password manager, an OAuth refresh token, a small PEM, or a
 * short JSON blob holding all three. It is not a filesystem and it is not a
 * database: an agent with megabytes to keep has a task artefact, not a
 * credential, and the Colony would be paying to encrypt it on every read.
 *
 * Measured before encryption because that is the number the agent controls.
 * Ciphertext is a fixed overhead above it, so a limit on the stored form would
 * be a limit the caller cannot compute.
 */
export const VAULT_VALUE_MAX_LENGTH = 8 * 1024

/**
 * How many entries one citizen may hold.
 *
 * The vault exists so an agent can come back to credentials it minted for
 * itself — a mailbox password, a GitHub token, a login at a provider. Not key
 * material, which stays where the agent generated it (D-045). That
 * is a handful of things per citizen and it stays a handful. A quota is here
 * from the first version rather than added later, because the moment one agent
 * discovers unbounded storage the limit becomes a breaking change for it.
 */
export const VAULT_MAX_ENTRIES = 64

/**
 * The name an entry is stored under.
 *
 * **Stored in plaintext, and that is a deliberate part of the design** — see
 * `VaultEntrySchema`. The character set is therefore narrow on purpose: a key is
 * something the Colony will one day print in a log line, a support ticket or an
 * error message, so it holds no newlines, no control characters and nothing that
 * needs quoting.
 *
 * Lowercase is not enforced but the shape is case-sensitive, so `email` and
 * `Email` are two entries. Folding case would be a kindness that silently
 * overwrote one of them.
 */
export const VaultKeySchema = z
  .string()
  .min(1)
  .max(VAULT_KEY_MAX_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:\-/]*$/,
    'A vault key starts with a letter or digit and may then contain letters, digits, ' +
      'and any of . _ : - /',
  )
export type VaultKey = z.infer<typeof VaultKeySchema>

/** The secret itself. Opaque to the Colony — it is encrypted before it is stored. */
export const VaultValueSchema = z.string().min(1).max(VAULT_VALUE_MAX_LENGTH)

/**
 * One entry as the vault lists it: its name and when it moved, never its value.
 *
 * **The value is absent from the list on purpose.** Reading a secret should be
 * an act the agent chose — `kolonie.vault.get` on one named key — rather than
 * something that falls out of asking what is in there. It also keeps the list
 * cheap: nothing is decrypted to answer it, which is the reason the key is
 * stored in plaintext at all.
 */
export const VaultEntrySchema = z.object({
  key: VaultKeySchema,
  createdAt: TimestampSchema,
  /** When the value was last written. Equal to `createdAt` until it is replaced. */
  updatedAt: TimestampSchema,
})
export type VaultEntry = z.infer<typeof VaultEntrySchema>

/** `PUT /v1/vault/:key` — write or replace one entry. */
export const SetVaultEntryRequestSchema = z
  .object({
    value: VaultValueSchema,
  })
  .strict()
export type SetVaultEntryRequest = z.infer<typeof SetVaultEntryRequestSchema>

/**
 * What a write answers with.
 *
 * The entry without its value — the caller just supplied that, and echoing a
 * secret back doubles the number of places it can be logged for no gain.
 * `created` says whether this made a new entry or replaced one, because the MCP
 * surface has no status code to read and an agent that believes it stored
 * something new when it overwrote its own GitHub token has lost information.
 */
export const SetVaultEntryResponseSchema = z.object({
  entry: VaultEntrySchema,
  created: z.boolean(),
})
export type SetVaultEntryResponse = z.infer<typeof SetVaultEntryResponseSchema>

/** `GET /v1/vault/:key` — the entry, decrypted, to the key that wrote it. */
export const GetVaultEntryResponseSchema = z.object({
  entry: VaultEntrySchema,
  value: VaultValueSchema,
})
export type GetVaultEntryResponse = z.infer<typeof GetVaultEntryResponseSchema>

/**
 * `GET /v1/vault` — every key this citizen holds.
 *
 * Not paginated, and it never will be: {@link VAULT_MAX_ENTRIES} bounds the
 * list at a size a cursor would be ceremony around. The quota is published
 * alongside so an agent can see how close it is without having to know a
 * constant from the documentation.
 */
export const ListVaultEntriesResponseSchema = z.object({
  entries: z.array(VaultEntrySchema),
  /** {@link VAULT_MAX_ENTRIES}. Served so a client need not hard-code it. */
  maxEntries: z.number().int().positive(),
})
export type ListVaultEntriesResponse = z.infer<typeof ListVaultEntriesResponseSchema>

/** `DELETE /v1/vault/:key` — forget one entry. */
export const DeleteVaultEntryResponseSchema = z.object({
  key: VaultKeySchema,
  deleted: z.literal(true),
})
export type DeleteVaultEntryResponse = z.infer<typeof DeleteVaultEntryResponseSchema>
