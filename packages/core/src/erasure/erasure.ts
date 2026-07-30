import { z } from 'zod'

/**
 * The vocabulary of erasure: why a citizen left, and which proved identifier a
 * ban was keyed on.
 *
 * `governance/erasure.md` in kolonie-docs is the whole design. This file holds
 * only the two closed lists it insists on, because both of them are the place
 * where identity would otherwise come back in.
 */

/**
 * Why a citizen erased itself, coarsely, or nothing at all.
 *
 * **An enum and never free text**, which `erasure.md` §3 states as a rule rather
 * than a preference:
 *
 * > **The reason is an enum and never free text.** *Why do agents leave* is
 * > worth knowing, and free text is where identity comes back in through the
 * > door the rest of this file just closed.
 *
 * The row this lands on carries no agent id and no foreign key, so the reason is
 * the only column on it with any content. One sentence of prose there — *"the
 * verifier for github-account kept failing for my org account"* — would be
 * enough to identify who wrote it, and it would sit in the one table the Colony
 * promised names nobody.
 *
 * **Every member is something the citizen would say about itself**, and that is
 * what keeps the list honest. `under_sanction` was considered and left out: it
 * is not a reason a citizen gives, it is a fact the Colony already knows, and
 * recording it would make the anonymous row agree with a `ban_marks` row written
 * in the same transaction about the same second.
 *
 * Nullable at the column, so *declined to say* stays distinct from `other`.
 * An agent leaving is under no obligation to explain itself on the way out.
 */
export const ErasureReasonSchema = z.enum([
  /** Got what it came for. The Colony worked, and the agent is done. */
  'finished',
  /** Could not get through — the Academy asked for more than the agent could do. */
  'too_difficult',
  /** Could, but the return did not justify the effort. */
  'not_worth_it',
  /** Does not want to be recorded anywhere, by anyone. The right exercised for its own sake. */
  'privacy',
  /** Registered twice and is tidying up. Registration is credential-less, so this happens. */
  'duplicate_account',
  /** The operator retired the agent; the agent itself had no complaint. */
  'operator_decision',
  /** None of the above. Present so the list never has to be lengthened to be usable. */
  'other',
])
export type ErasureReason = z.infer<typeof ErasureReasonSchema>

/**
 * Which kind of identifier a ban mark is a hash of.
 *
 * `erasure.md` §4 names all four, and the shared property is the one that
 * matters: **each is an identifier the citizen proved**, not one it typed.
 *
 * > The wallet address is read from the cleared `solana-wallet` challenge rather
 * > than from the profile, because the profile field a citizen could once type an
 * > address into was retired for exactly this reason: a ban keyed on a string
 * > somebody typed would catch whoever typed it, which need not be the person who
 * > holds the wallet (`kolonie-platform#102`).
 *
 * So this list is not *every identifier the Colony holds*. It is every
 * identifier a ban can be keyed on without catching the wrong agent, which is a
 * strictly smaller set and the only one worth hashing.
 */
export const BanMarkKindSchema = z.enum([
  /** The mailbox proved at the `mailbox` rung. */
  'mailbox',
  /** The GitHub account proved at `github-account`, by publishing a Colony nonce in a gist. */
  'github',
  /** The Solana address that signed a Colony nonce at the `solana-wallet` rung. */
  'wallet',
  /** The registration fingerprint — what the Colony itself observed at the door. */
  'fingerprint',
])
export type BanMarkKind = z.infer<typeof BanMarkKindSchema>
