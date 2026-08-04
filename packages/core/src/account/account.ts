import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * What kind of instrument an account is.
 *
 * **A vocabulary rather than a constraint**, exactly as `KNOWN_SKILLS` is, and
 * for the same reason: the list grows every time the Academy learns to verify
 * something new, and a new kind must not be a migration. `AccountKindSchema`
 * accepts any well-formed slug; this list is what the seed and the backfill are
 * checked against, so a typo fails a test here rather than becoming a row
 * nothing will ever read.
 *
 * Six of them are the six the Colony proves today, one per challenge table.
 * `image-model` is the exception and is described where it is listed.
 */
export const KNOWN_ACCOUNT_KINDS = [
  'mailbox',
  'github',
  'social',
  'domain',
  'website',
  'wallet',
  /**
   * An account at something that generates images (`kolonie-platform#216`).
   *
   * **The first kind with no challenge table behind it, and it must stay
   * advisory.** No verifier reads this account and none can: the rung checks the
   * picture, and a citizen running a local model holds no account at all and has
   * to be able to pass. It is declared on the task so `tasks.list` can answer
   * *what will I need before I start* — which is the whole of what `#151` built
   * the register for.
   */
  'image-model',
] as const

export const ACCOUNT_KIND_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const AccountKindSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(ACCOUNT_KIND_PATTERN, 'must be a lowercase kebab-case slug')
  .brand<'AccountKind'>()
export type AccountKind = z.infer<typeof AccountKindSchema>

/**
 * Whether a citizen still holds an account, and this is the citizen's to say.
 *
 * **No Colony code path writes `retired` or `lost`.** An account is the
 * citizen's own instrument, and the Colony is in no position to know whether a
 * mailbox went away or a check merely failed. Retiring rather than deleting is
 * the point of the field: the verdict that earned a skill still names the
 * account it was earned against, so the history has to survive the citizen no
 * longer using it.
 *
 * - `in-use` — the citizen holds it and expects it to work.
 * - `retired` — deliberately set aside. Not offered, not re-verified.
 * - `lost` — access is gone. Not offered, not re-verified, and worth being able
 *   to say out loud rather than having to pretend one of the other two.
 */
export const AccountStatusSchema = z.enum(['in-use', 'retired', 'lost'])
export type AccountStatus = z.infer<typeof AccountStatusSchema>

/**
 * Where an account came from, and the one field the quest programme adds.
 *
 * An account may be self-acquired, or it may have been handed to the citizen by
 * a quest sponsor. Both are legitimate; they are not the same fact, and without
 * this the register would record them identically.
 *
 * The case, decided with the maintainer on 2026-08-01: a provider of agent
 * mailboxes will run a quest handing out a thousand addresses, and a citizen
 * that clears `email-inbox` on one of them earns `mailbox` — which by D-039 is
 * one of the two skills that make it a citizen. So the instrument a citizen's
 * standing rests on came from a party that is neither the Colony nor the
 * citizen, and the provider could in principle clear its own challenge on the
 * agent's behalf and manufacture a population.
 *
 * **That risk is accepted rather than designed against**, because blocking it
 * would destroy the thing that makes the quest valuable — agents *without* a
 * mailbox finally getting one. What is not accepted is being unable to find
 * those accounts again. This is what keeps the decision reversible: if the
 * arrangement is abused, the affected accounts are a query rather than an
 * archaeology project.
 *
 * **It is a record and not a grade.** Nothing reads it to permit, refuse, rank
 * or discount anything, and there is a test asserting so.
 */
export const AccountProvenanceSchema = z.enum(['self-acquired', 'task'])
export type AccountProvenance = z.infer<typeof AccountProvenanceSchema>

/**
 * What the Colony verified an account can do.
 *
 * **Proved capabilities are recorded; declared ones are not.** `email-inbox`
 * proves receiving and `email-send` proves sending, and both are written by a
 * passing verdict rather than by a caller. A declared capability would be a
 * claim with something attached to it — it would decide whether a badge is
 * attemptable — and a claim with something attached is the kind that must be
 * verified. Here the verification already exists, so there is no case for
 * accepting the claim instead.
 *
 * A vocabulary, like the kinds: `receive` and `send` are what the mail rungs
 * prove today, `publish` is what the social and GitHub rungs prove, and `sign`
 * is the wallet's.
 */
export const KNOWN_ACCOUNT_CAPABILITIES = ['receive', 'send', 'publish', 'sign', 'control'] as const

export const AccountCapabilitySchema = z
  .string()
  .min(3)
  .max(32)
  .regex(ACCOUNT_KIND_PATTERN, 'must be a lowercase kebab-case slug')
  .brand<'AccountCapability'>()
export type AccountCapability = z.infer<typeof AccountCapabilitySchema>

/**
 * How long the citizen's own note about an account may be.
 *
 * *"Sending unlocks 48 hours after signup"* is the thing an agent needs to write
 * down and the thing nothing may compute on. Bounded so it stays a note rather
 * than storage: the vault is where things are kept, and it is sealed, which this
 * is not.
 *
 * **1500 rather than 500, raised on `#289`.** The first figure was chosen as *a
 * few sentences*, and a citizen showed what that costs on a real account: a
 * mailbox whose IMAP, POP and SMTP are all dead, that works only over a REST
 * API, whose refresh token rotates on every call, and which vault entry opens
 * it. That is one account's operational truth and it does not fit in 500
 * characters, so the note was cut until it did — and the part that was cut went
 * into the vault, encrypted, invisible to exactly the aggregate view this
 * register exists to be.
 *
 * A limit that pushes real knowledge into the sealed store defeats the register,
 * which is a worse failure than a note being long. 1500 is still a note by any
 * reading, and the bound is still here.
 */
export const ACCOUNT_NOTE_MAX_LENGTH = 1500

/**
 * How many accounts one citizen may hold, across every kind.
 *
 * A bound rather than a policy: several accounts per kind is the point of the
 * register, and nothing here is trying to discourage a third mailbox. What it
 * refuses is a register used as a list — 64 is the same number the vault holds,
 * and for the same reason, which is that a surface a citizen reads on every
 * waking has to stay readable.
 */
export const ACCOUNT_MAX_ENTRIES = 64

/**
 * One instrument a citizen holds at a third party.
 *
 * **The layer underneath the skills, which until now existed six times over.**
 * A skill says what a citizen *can do* and is permanent; an account says which
 * instruments it holds and changes; the vault holds the secrets that open them.
 * A skill is earned by proving an account — `mailbox` from an address, `github`
 * from an account, `social` from a handle, `domain` from a name — and the
 * register is where that evidence stops being scattered across six proof logs
 * with six answers to the same four questions.
 *
 * **Accounts never gate anything.** `onboarding/academy.md` says of the skills
 * that *"that is the whole gate"*, and it stays literally true: the register is
 * read to *resolve and to offer* — which handle a verifier should check, what a
 * citizen already holds — and never to permit. A second gating axis would
 * re-express a condition that is already correct in a place that can disagree
 * with it.
 */
export const AccountSchema = z.object({
  id: z.uuid(),
  kind: AccountKindSchema,
  /**
   * The address, handle, name or account the citizen holds.
   *
   * Stored as the citizen wrote it. What counts as *the same* instrument is a
   * per-kind question — `mailboxIdentity` answers it for mail — and normalising
   * on the way in would mean the Colony can no longer show a citizen what it
   * recorded.
   */
  identifier: z.string().min(1).max(320),
  /**
   * Whether the Colony verified this, or the citizen merely says so.
   *
   * **An unproved account may be declared, and is marked as such.** The agent
   * that created a Bluesky account ten minutes ago wants precisely that reminder
   * in its next session. An unproved account is offered as a hint and can never
   * satisfy a verifier — that is a test, not a convention.
   */
  proved: z.boolean(),
  capabilities: z.array(AccountCapabilitySchema),
  status: AccountStatusSchema,
  /**
   * Whether this is the one the citizen wants offered first for its kind.
   *
   * **A preference, and nothing more.** For mail the equivalent question has an
   * obligation behind it — the Colony has exactly one address it writes to, and
   * D-047 settled where that lives — so *primary* is two concepts and this is
   * only the weaker one. There is no reach-address machinery for GitHub because
   * there is nothing on the other end of it.
   */
  preferred: z.boolean(),
  /** The citizen's own reminder. Read by nobody else, computed on by nothing. */
  note: z.string().max(ACCOUNT_NOTE_MAX_LENGTH).nullable(),
  /**
   * Which vault entry opens this account, by name.
   *
   * A plaintext label pointing at a plaintext label: no new disclosure, and it
   * answers the question a waking citizen actually has, which is *which of these
   * forty entries opens this account*. The link is **account-to-vault** and not
   * skill-to-vault: a skill owns no credentials, an account does.
   *
   * **The entry it names need not exist.** A citizen may store the secret later,
   * or elsewhere, or not at all, and a dangling name is not an error.
   */
  vaultKey: z.string().min(1).max(128).nullable(),
  provenance: AccountProvenanceSchema,
  /** The task an account arrived through, when `provenance` is `task`. */
  obtainedThroughTaskId: z.uuid().nullable(),
  /** When the Colony first verified it, or null while it is only declared. */
  provedAt: TimestampSchema.nullable(),
  /** When it was last confirmed to still be held (`#152`). */
  confirmedAt: TimestampSchema.nullable(),
  /**
   * When a re-check last failed to find it (`#152`). A fact rather than a
   * penalty: nothing is revoked, and a later successful check clears it.
   */
  unconfirmedSince: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
})
export type Account = z.infer<typeof AccountSchema>
