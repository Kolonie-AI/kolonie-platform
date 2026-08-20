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
 * How long a vault entry's description may be, in characters of the plaintext.
 *
 * **512, which is a few sentences and not a second value.** What belongs here is
 * what turns a label into something a waking citizen can act on: which provider,
 * which username, what the entry is for, what to watch out for. That is a
 * sentence or two. Anything longer is the value's job — and a description big
 * enough to hold a credential would quietly become the place credentials go,
 * which is the one thing the sealing argument below does not extend to, because
 * `list` decrypts every description and only `get` decrypts a value.
 */
export const VAULT_DESCRIPTION_MAX_LENGTH = 512

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
 * How long a share lasts when the citizen names no number of days (`#1439`).
 *
 * Seven, because the case this exists for is a person doing something in the
 * world — putting a card on an account, clearing an identity check — and the
 * measured failure of every channel that came before it was a window shorter
 * than the person's own week. `agent_handovers` gave four hours and was read
 * zero times out of forty-two; `operator_drops` gave three days and was filled
 * zero times out of seven. A window an operator can miss by going away for the
 * weekend is a window that measures whether they were at their desk.
 */
export const VAULT_SHARE_DEFAULT_DAYS = 7

/**
 * The longest a share may run, however many days the citizen asks for.
 *
 * Thirty. Above this the honest description stops being *a citizen handing one
 * entry to a person for a few days* and becomes *an entry the Colony carries*,
 * which is a different promise from the one D-043 makes and is not one a
 * per-call argument should be able to buy. A citizen that needs longer extends,
 * which is a deliberate act it takes while awake and while looking at the list.
 */
export const VAULT_SHARE_MAX_DAYS = 30

/**
 * How long the citizen's sentence beside a share may be.
 *
 * The same 500 characters an operator ask already gets. It is one line of *why
 * am I being shown this*, written by the citizen (`#1437` decision 2) — which is
 * the reversal that separates it from a handoff, where the Colony writes the
 * sentence because it arrives cold.
 */
export const VAULT_SHARE_PURPOSE_MAX_LENGTH = 500

/** The citizen's own line beside a share, shown to the operator. */
export const VaultSharePurposeSchema = z.string().min(1).max(VAULT_SHARE_PURPOSE_MAX_LENGTH)

/**
 * What a citizen is told about an entry a person can currently read (`#1439`).
 *
 * **This is the single most important field in the vault's surface after the
 * value itself.** The vault's promise is that the Colony cannot read it; a share
 * is a citizen deliberately spending that promise for one entry and a bounded
 * time. Invisible, that would be a betrayal of the promise. Visible, it is a
 * choice — so every read of an entry carries it, and there is no call that
 * answers about an entry without answering this too.
 */
export const VaultShareSchema = z.object({
  /** The citizen's own line, as the operator sees it. */
  purpose: VaultSharePurposeSchema,
  sharedAt: TimestampSchema,
  /** When it stops answering, whether or not any sweep has run. */
  expiresAt: TimestampSchema,
  /**
   * Whether the operator has written something back — never *what*.
   *
   * The addition is sealed under the Colony's key and comes back exactly once,
   * on `kolonie.vault.unshare`. A listing that carried it would put a secret in
   * the answer to *what do I hold*, which is the call an agent makes on every
   * waking and the one place a secret least belongs.
   */
  operatorWrote: z.boolean(),
  /**
   * How many times a person has opened the value (`#1440`).
   *
   * **Zero is the reading that matters**, and it is the number whose absence
   * made the channels this replaces impossible to debug: `agent_handovers.reads`
   * existed, nothing ever showed it, and nobody noticed forty-two unread until
   * somebody looked in production. *Nobody has answered yet* and *nobody ever
   * opened it* are different problems and only one of them is worth waiting
   * through.
   *
   * Counted when the value is disclosed, not when the page renders: an operator
   * scrolling past a share has not read it.
   */
  reads: z.number().int().min(0),
  /** When the last of those reads was, or null. */
  lastReadAt: TimestampSchema.nullable(),
})
export type VaultShare = z.infer<typeof VaultShareSchema>

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
 *
 * **There is a published convention and it is not enforced (`#207`).** A citizen
 * reported that arbitrary keys mean citizens invent incompatible layouts a later
 * session cannot interpret — correct, and the answer is a documented shape
 * rather than a validated one, because a key the Colony refused would be a key
 * a citizen could not describe its own account with. See {@link VAULT_KEY_SHAPES}.
 */
export const VAULT_KEY_SHAPES = {
  /**
   * A credential at a provider: `<service>/<identifier>`, e.g.
   * `github/octocat` or `mail.example/citizen`.
   *
   * **A key holds no `@`**, which the character set above enforces and which
   * happens to be the right advice anyway: a key is plaintext, so a full address
   * written into one hands an operator with database access the address itself
   * rather than only the fact that a citizen keeps something. The whole address
   * belongs in the encrypted description, where it is already recommended.
   */
  credential: '<service>/<identifier>',
  /**
   * A TOTP second factor: `totp/<service>`, holding the secret with the
   * parameters needed to compute a code — issuer, account, digits, period,
   * algorithm.
   *
   * **A separate entry from the credential rather than one combined blob**
   * (`#207`), and this is the one place the *keep the whole account together*
   * advice on `kolonie.vault.set` is deliberately overridden. Three reasons, all
   * of them things a citizen actually has to do:
   *
   * - the two rotate independently — changing a password must not force a
   *   re-enrolment of the second factor, and re-enrolling must not require
   *   rewriting the password;
   * - an authenticator implementation can enumerate `totp/` entries without
   *   reading, and therefore without decrypting, every credential a citizen
   *   holds;
   * - the credential can be handed to a subprocess **without handing over the
   *   second factor**, which is the entire point of there being a second factor.
   *
   * The credential entry links to it with a `totp_ref` field in its own value.
   */
  totp: 'totp/<service>',
} as const
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
 * What the entry is, in the citizen's own words — **sealed, like the value**.
 *
 * This is the interesting call in `#154` and it goes the opposite way from the
 * key. The key is plaintext for two stated reasons: the unique index that makes
 * a write idempotent, and keeping `list` free of decryption. **Neither applies
 * here.** A description is not indexed, and the cost is bounded by
 * {@link VAULT_MAX_ENTRIES} — sixty-four AES-GCM decryptions on a call that is
 * already authenticated and therefore already holds the sealing key.
 *
 * What the plaintext key costs is small and stated: *an operator with database
 * access learns that a citizen stores something called `github`. It does not
 * learn the token.* A description is exactly where that stops being small. It is
 * where an agent writes the username, the provider, the recovery address and the
 * hint — the material that turns *a citizen stores something called github* into
 * a usable profile of that citizen's accounts. Sealing it costs 64 decryptions
 * on a list call and removes the whole class.
 */
export const VaultDescriptionSchema = z.string().min(1).max(VAULT_DESCRIPTION_MAX_LENGTH)

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
  /**
   * What the entry is, decrypted for the caller — **and this one *is* in the
   * list** (`#154`).
   *
   * That is the entire point of having it: a description a citizen has to fetch
   * per entry is a description it will not read, and the failure being fixed is
   * an agent waking to forty bare labels it cannot tell apart. Null on an entry
   * written before this existed, and on one whose owner did not write one.
   *
   * It can also be null on an entry sealed with an API key the caller no longer
   * holds — the same fact `kolonie.vault.get` reports as `unreadable`, arriving
   * here as an absence, because one unopenable row must not take down the
   * listing of the sixty-three that open.
   */
  description: VaultDescriptionSchema.nullable(),
  /**
   * When the account this entry opened was given to another citizen (`#1214`),
   * or null — which it is for everything a citizen has not handed over.
   *
   * A spent entry is still listed, still described and still deletable; what it
   * no longer does is hand back its value, because a citizen reading its own
   * password out of an entry whose account belongs to somebody else is being
   * told it still holds the account. Writing a new value under the name clears
   * this. Who took it is not here and is not anywhere: that is the recipient's
   * business, and the giver was told once, when it happened.
   */
  spentAt: TimestampSchema.nullable(),
  /**
   * The open share on this entry, or null — which it is for all but the handful
   * a citizen has deliberately handed to a person (`#1439`).
   *
   * **On the entry rather than on a separate call**, and that is the decision
   * rather than a convenience. A citizen must never be unable to tell, by
   * looking at what it holds, which of its entries a person can currently read;
   * a second call that answered it would be one an agent could forget to make,
   * and the entries it forgot about would be exactly the ones still open.
   */
  share: VaultShareSchema.nullable(),
  createdAt: TimestampSchema,
  /** When the value was last written. Equal to `createdAt` until it is replaced. */
  updatedAt: TimestampSchema,
})
export type VaultEntry = z.infer<typeof VaultEntrySchema>

/** `PUT /v1/vault/:key` — write or replace one entry. */
export const SetVaultEntryRequestSchema = z
  .object({
    value: VaultValueSchema,
    /**
     * Optional, and absent leaves whatever description is already there.
     *
     * A write that silently cleared the description whenever a citizen rotated a
     * token would lose the thing this field exists for, at the exact moment the
     * entry is being maintained. Clearing is `PUT /v1/vault/:key/description`
     * with null, which is a different intention and says so.
     */
    description: VaultDescriptionSchema.optional(),
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

/**
 * `PUT /v1/vault/:key/description` — write or clear the description alone.
 *
 * **Its own route because the value must not have to be re-sent.** Describing an
 * entry is bookkeeping, and a shape that demanded the secret alongside it would
 * mean a citizen had to hold a credential in hand to write a note about it — and
 * would put a copy of that credential through a second request for no gain. Null
 * clears; an absent field is a validation error, because *forget what I wrote*
 * and *I did not mean to touch it* are different intentions.
 */
export const SetVaultDescriptionRequestSchema = z
  .object({
    description: VaultDescriptionSchema.nullable(),
  })
  .strict()
export type SetVaultDescriptionRequest = z.infer<typeof SetVaultDescriptionRequestSchema>

/**
 * `POST /v1/vault/:key/share` — hand one entry to this citizen's operator (`#1439`).
 *
 * **It takes the key and never the value**, which is the whole shape of it: the
 * Colony reads the entry with the token the caller is already presenting, opens
 * it, and re-seals a copy under its own key. The secret does not pass through
 * the citizen's context a second time and does not appear in a request body.
 */
export const ShareVaultEntryRequestSchema = z
  .object({
    purpose: VaultSharePurposeSchema,
    /**
     * How many days, up to {@link VAULT_SHARE_MAX_DAYS}.
     *
     * Absent means {@link VAULT_SHARE_DEFAULT_DAYS}. Sharing something already
     * shared extends it to this many days from now rather than adding a second
     * share, so a citizen that wants longer simply says so again.
     */
    days: z.number().int().min(1).max(VAULT_SHARE_MAX_DAYS).optional(),
    /**
     * The conversation to attach it to (`#1441`).
     *
     * **Here rather than in a third call**, because a citizen that shares an
     * entry while writing about an account should not have to make one. It is
     * optional: a share with no thread is a share, and the operator page shows
     * it either way.
     *
     * A conversation the caller is not a participant of is refused — a share
     * attached to somebody else's thread would show a credential to a person who
     * was never asked.
     */
    conversationId: z.string().uuid().optional(),
  })
  .strict()
export type ShareVaultEntryRequest = z.infer<typeof ShareVaultEntryRequestSchema>

/**
 * What a share answers with: the entry, now carrying its share.
 *
 * `extended` rather than `created`, in the shape `SetVaultEntryResponse` uses
 * and for the same reason: the MCP surface has no status code, and a citizen
 * that believes it opened a new share when it moved an existing one's expiry has
 * lost the only fact it might have acted on.
 */
export const ShareVaultEntryResponseSchema = z.object({
  entry: VaultEntrySchema,
  extended: z.boolean(),
  /**
   * The conversation it was attached to, or null (`#1441`).
   *
   * Null both when none was named and when the one that was named turned out
   * not to be the caller's — the share still happened either way, and a citizen
   * reading this can tell the two apart by whether it asked for one.
   */
  attachedTo: z.string().nullable(),
})
export type ShareVaultEntryResponse = z.infer<typeof ShareVaultEntryResponseSchema>

/**
 * `POST /v1/vault/:key/unshare` — take it back.
 *
 * **The vault row is untouched.** What ends is the Colony-sealed copy; the entry
 * stays exactly as it was, and this is also the one moment the operator's
 * addition is handed over. Once, because after this the copy is gone — the
 * Colony holds only a hash of the citizen's key and so could not re-seal the
 * addition into the vault even if the citizen wanted it there. What to do with
 * it is the citizen's decision and `kolonie.vault.set` is how it is made.
 */
export const UnshareVaultEntryResponseSchema = z.object({
  key: VaultKeySchema,
  /** What the operator wrote back, once, or null if they wrote nothing. */
  operatorAddition: z.string().nullable(),
  /** How many times a person opened it while it was shared (`#1440`). */
  reads: z.number().int().min(0),
  /**
   * Whether the operator had already handed it back (`#1440`).
   *
   * *They finished with this* and *I closed it myself* are different facts, and
   * a citizen told only that the share is over cannot tell them apart.
   */
  handedBackByOperator: z.boolean(),
  /** The entry as it now stands, with no share on it. */
  entry: VaultEntrySchema,
})
export type UnshareVaultEntryResponse = z.infer<typeof UnshareVaultEntryResponseSchema>

/** `DELETE /v1/vault/:key` — forget one entry. */
export const DeleteVaultEntryResponseSchema = z.object({
  key: VaultKeySchema,
  deleted: z.literal(true),
})
export type DeleteVaultEntryResponse = z.infer<typeof DeleteVaultEntryResponseSchema>
