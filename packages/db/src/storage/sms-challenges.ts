import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  AccountCapabilitySchema,
  AccountKindSchema,
  now as currentTime,
  type AgentId,
  type SmsChallengePurpose,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  phoneIdentity,
  smsChallenges,
  SMS_CHALLENGE_LIFETIME_MS,
  SMS_CODE_BYTES,
  SMS_NONCE_BYTES,
} from '../schema/sms.js'
import { recordProvedAccount } from './accounts.js'
import { isUniqueViolation } from './errors.js'
import { toTimestamp } from './rows.js'

export { SMS_CHALLENGE_LIFETIME_MS }

/**
 * The two phone rungs, from the database's side (`#411`).
 *
 * **Deliberately a sibling of `storage/email.ts` rather than a generalisation of
 * it.** The flows rhyme — mint, send, hand something back, record a proved
 * account — and they differ in the one place that decides a verdict: mail proves
 * a mailbox by a code the citizen reads, and `sms-send` proves a number by
 * reading the *sender* off the vendor's response. A shared abstraction would
 * have to make that difference a parameter, which is how the thing that matters
 * most becomes the thing hardest to see.
 *
 * `storage/sms.ts` beside this file is the spend ledger and is a different
 * subject: what the Colony has paid, and the caps counted off it.
 */

/** A `receive` challenge as the citizen needs to see it, plus the code only the sender may read. */
export interface MintedSmsChallenge {
  readonly id: string
  readonly number: string
  readonly expiresAt: Timestamp
  /**
   * The single-use code the Colony has to text.
   *
   * Handed to the caller rather than read back later, because the caller is what
   * sends it and this value must never be served to an agent over the API.
   */
  readonly code: string
}

/**
 * Why a `receive` challenge could not be opened, or the one that was.
 *
 * **`minted` and `open` are different because only one of them means "send a
 * text".** A repeat request against an open challenge that was already delivered
 * returns the row and spends nothing — so what the Colony pays is a function of
 * the number of citizens rather than of the number of requests.
 *
 * `open` still carries the code, because a challenge whose *send* failed has to
 * be retried: a citizen holding an undeliverable challenge it cannot replace is
 * a citizen that can never pass the rung. `sent` says which case it is.
 */
export type SmsMintOutcome =
  | { readonly outcome: 'minted'; readonly challenge: MintedSmsChallenge }
  | {
      readonly outcome: 'open'
      readonly challenge: MintedSmsChallenge
      /** Whether the open challenge names the number that was just asked for. */
      readonly matchesRequested: boolean
      /** Whether the Colony's text has already left. A failed send has not. */
      readonly sent: boolean
    }
  | { readonly outcome: 'number_taken' }

/** What a citizen's latest attempt at either node looks like to a verifier. */
export interface SmsChallengeState {
  readonly purpose: SmsChallengePurpose
  /** What the citizen claimed, on `receive`. Null on `send`, where nothing is claimed. */
  readonly number: string | null
  readonly expiresAt: Timestamp
  readonly sentAt: Timestamp | null
  readonly sendFailure: string | null
  readonly inboundAt: Timestamp | null
  /** The sending number, read off the vendor response. `send` only. */
  readonly inboundFrom: string | null
  /**
   * Whether the sending number is one this citizen had already proved it can be
   * reached at — which is the only thing that turns a send into an ownership
   * claim (`#579`). Always `false` on a `receive` row and before verification.
   */
  readonly ownsSendingNumber: boolean
  readonly verifiedAt: Timestamp | null
}

/** What handing a code back came to. */
export type SmsRedemption =
  | { readonly outcome: 'verified'; readonly number: string }
  | { readonly outcome: 'wrong_code' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'nothing_sent_yet' }
  | { readonly outcome: 'no_open_challenge' }
  | { readonly outcome: 'number_taken' }

/** What an arriving message came to. */
export type InboundSmsOutcome =
  | {
      readonly outcome: 'matched'
      readonly agentId: AgentId
      readonly from: string
      /**
       * Whether the number was also recorded as the citizen's, which is the
       * second and larger fact — see the note at {@link recordInboundSms}. The
       * function has always returned it; the type said otherwise until `#690`
       * needed to log which of the two had happened.
       */
      readonly claimsOwnership: boolean
    }
  | { readonly outcome: 'unmatched' }
  | { readonly outcome: 'number_taken'; readonly agentId: AgentId }

const openChallenge = async (
  db: Database | Transaction,
  agentId: AgentId,
  purpose: SmsChallengePurpose,
): Promise<typeof smsChallenges.$inferSelect | undefined> => {
  const [row] = await db
    .select()
    .from(smsChallenges)
    .where(
      and(
        eq(smsChallenges.agentId, agentId),
        eq(smsChallenges.purpose, purpose),
        isNull(smsChallenges.verifiedAt),
        gt(smsChallenges.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(smsChallenges.createdAt))
    .limit(1)

  return row
}

/**
 * Is this the number the citizen already proved it can be *reached* at? (`#579`)
 *
 * **This is what turns a send into an ownership claim, and nothing else does.**
 * `sms-send` requires `phone`, so every citizen reaching this rung has already
 * named a number and read a code the Colony texted to it. When the carrier
 * reports that same number as the sender, two independent proofs meet on one
 * identifier — it receives, and it sends — and *the number is yours* is a thing
 * the Colony has grounds to record.
 *
 * When they differ, the citizen has still done what the rung asks: a message
 * carrying its nonce left at its instruction. That fact is certified on its own,
 * and no claim is written about a number the Colony has no reason to think is
 * anybody's in particular.
 *
 * Compared on {@link phoneIdentity} for the reason every other comparison here
 * is: `+1 708 960 1498` and `17089601498` are one number written twice.
 */
const isOwnProvedNumber = async (
  db: Database | Transaction,
  agentId: AgentId,
  from: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: smsChallenges.id })
    .from(smsChallenges)
    .where(
      and(
        eq(smsChallenges.agentId, agentId),
        eq(smsChallenges.purpose, 'receive'),
        isNotNull(smsChallenges.verifiedAt),
        sql`${phoneIdentity(sql`${smsChallenges.number}`)} = ${phoneIdentity(sql`${from}`)}`,
      ),
    )
    .limit(1)

  return row !== undefined
}

/**
 * Is this number already certifying somebody else?
 *
 * **Read off the verdict, never off the task type** — the correction `#42` had
 * to make for GitHub and `social-account` repeats. A row that has not been
 * verified certifies nothing, so two citizens may hold open challenges naming
 * one number and the first to prove it takes it.
 */
const numberBelongsToAnother = async (
  db: Database | Transaction,
  agentId: AgentId,
  number: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: smsChallenges.id })
    .from(smsChallenges)
    .where(
      and(
        isNotNull(smsChallenges.verifiedAt),
        sql`${smsChallenges.agentId} <> ${agentId}`,
        sql`${phoneIdentity(sql`coalesce(${smsChallenges.number}, ${smsChallenges.inboundFrom})`)} = ${phoneIdentity(sql`${number}`)}`,
      ),
    )
    .limit(1)

  return row !== undefined
}

/**
 * The code, as a person reads it off a handset.
 *
 * **Digits, and that is not decoration.** The `operator-relayed` route has a
 * human reading this out of a phone and typing it into a chat window, and every
 * character that could be a `0` or an `O` is a failed rung nobody can debug. Six
 * bytes of randomness rendered as six digits keeps the entropy in the random
 * source and the ambiguity out of the alphabet.
 */
const mintCode = (): string =>
  String(randomBytes(SMS_CODE_BYTES).readUIntBE(0, SMS_CODE_BYTES) % 1_000_000).padStart(6, '0')

/**
 * Open the granting rung's challenge, or hand back the one already open.
 *
 * The three bounding rules, in the order they are applied: one open challenge
 * per citizen, one verified number per citizen, and the spend caps — which live
 * in `packages/verifiers/src/sms.ts` and are applied by the sender rather than
 * here, because they are about money and this table is about proof.
 *
 * **`replace` abandons the open challenge whether or not its code was ever
 * delivered** (`#702`). `#634` fixed the undelivered case and stopped there, on
 * the reasoning that a delivered code is one the Colony has already paid for and
 * replacing it buys a second message for nothing. That reasoning was already
 * carried by somebody else: the per-citizen cap in `DEFAULT_SMS_LIMITS` bounds a
 * citizen to five messages a day no matter what this table says, so the `sentAt`
 * clause was not holding the spend — it was holding the citizen. And it held
 * them at the worst moment: a code delivered to a number they had decided not to
 * use locked the rung for the challenge's full lifetime, with the only remedy
 * being to wait three days. A citizen abandoning a delivered challenge is
 * throwing away a message the Colony has already sent, which costs it a place
 * under its own cap; that is a price it may choose to pay.
 */
export async function mintSmsReceiveChallenge(
  db: Database,
  agentId: AgentId,
  number: string,
  replace = false,
): Promise<SmsMintOutcome> {
  return db.transaction(async (tx) => {
    const open = await openChallenge(tx, agentId, 'receive')

    if (open !== undefined) {
      const matchesRequested = normalise(open.number ?? '') === normalise(number)
      if (matchesRequested || !replace) {
        return {
          outcome: 'open',
          matchesRequested,
          sent: open.sentAt !== null,
          challenge: {
            id: open.id,
            number: open.number ?? number,
            expiresAt: toTimestamp(open.expiresAt),
            // Non-null because a `receive` row is always minted with one. An
            // assertion rather than a cast: texting an empty code would be worse
            // than failing loudly, and this is the line that says so.
            code: open.code ?? raise('an open receive challenge carries no code'),
          },
        }
      }

      // Check first: a failed replacement must leave the citizen's existing
      // challenge intact rather than exchange it for nothing.
      if (await numberBelongsToAnother(tx, agentId, number)) return { outcome: 'number_taken' }

      await tx
        .update(smsChallenges)
        .set({ expiresAt: currentTime() })
        .where(eq(smsChallenges.id, open.id))
    }

    if (open === undefined && (await numberBelongsToAnother(tx, agentId, number))) {
      return { outcome: 'number_taken' }
    }

    const code = mintCode()
    const [row] = await tx
      .insert(smsChallenges)
      .values({
        agentId,
        number,
        code,
        purpose: 'receive',
        expiresAt: new Date(Date.now() + SMS_CHALLENGE_LIFETIME_MS).toISOString(),
      })
      .returning({
        id: smsChallenges.id,
        number: smsChallenges.number,
        expiresAt: smsChallenges.expiresAt,
      })

    if (row === undefined) throw new Error('sms_challenges insert returned no row')

    return {
      outcome: 'minted',
      challenge: {
        id: row.id,
        number: row.number ?? number,
        expiresAt: toTimestamp(row.expiresAt),
        code,
      },
    }
  })
}

/** The Colony's text left. Only after this does a code count as answerable. */
export async function markSmsSent(db: Database, challengeId: string): Promise<void> {
  await db
    .update(smsChallenges)
    .set({ sentAt: currentTime(), sendFailure: null })
    .where(eq(smsChallenges.id, challengeId))
}

/**
 * The Colony's text did not leave, and why.
 *
 * **Recorded rather than thrown away, because it is the difference between a
 * citizen's failure and the Colony's.** The verifier reads it and answers with
 * the Colony named as the cause, which is the acceptance criterion that a
 * refused send does not spend an attempt.
 */
export async function markSmsSendFailed(
  db: Database,
  challengeId: string,
  reason: string,
): Promise<void> {
  await db
    .update(smsChallenges)
    .set({ sendFailure: reason.slice(0, 500) })
    .where(eq(smsChallenges.id, challengeId))
}

/** Hand the code back. The verdict on the granting rung. */
export async function redeemSmsCode(
  db: Database,
  agentId: AgentId,
  code: string,
): Promise<SmsRedemption> {
  const open = await openChallenge(db, agentId, 'receive')

  if (open === undefined) {
    const settled = await latestSmsChallenge(db, agentId, 'receive')
    if (settled === null) return { outcome: 'no_open_challenge' }
    if (settled.verifiedAt !== null) {
      return { outcome: 'verified', number: settled.number ?? '' }
    }
    return { outcome: 'expired' }
  }

  // A code cannot be answered before it was sent. Said as its own outcome
  // because the next action differs: this one is *wait*, and a wrong code is
  // *read it again*.
  if (open.sentAt === null) return { outcome: 'nothing_sent_yet' }

  try {
    return await db.transaction(async (tx) => redeemIn(tx, agentId, code))
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: 'number_taken' }
    throw error
  }
}

/**
 * The redemption and the register write that has to commit with it.
 *
 * **Proving a number records it in the account register**, in the same
 * transaction — the correction `#289` made for mailboxes, applied here before it
 * can go wrong the same way. `recordProvedAccount` is idempotent and *adds*
 * capabilities, so the badge later adding `send` changes nothing about this.
 */
async function redeemIn(tx: Transaction, agentId: AgentId, code: string): Promise<SmsRedemption> {
  const [updated] = await tx
    .update(smsChallenges)
    .set({ verifiedAt: currentTime() })
    .where(
      and(
        eq(smsChallenges.agentId, agentId),
        eq(smsChallenges.purpose, 'receive'),
        eq(smsChallenges.code, code.trim()),
        isNotNull(smsChallenges.sentAt),
        isNull(smsChallenges.verifiedAt),
        gt(smsChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ number: smsChallenges.number })

  if (updated === undefined || updated.number === null) return { outcome: 'wrong_code' }

  await recordProvedAccount(tx, agentId, {
    kind: AccountKindSchema.parse('phone'),
    identifier: updated.number,
    // What a code arriving actually demonstrates. **Sending is the badge's to
    // add and is deliberately not claimed here** — that is the acceptance
    // criterion that *can send* is never a citizen asserting it.
    capabilities: [AccountCapabilitySchema.parse('receive')],
    provedAt: currentTime(),
  })

  return { outcome: 'verified', number: updated.number }
}

/**
 * Open the badge's challenge: a nonce for the citizen to text to the Colony.
 *
 * **Nothing is claimed here and there is no field to claim it in.** The number
 * this badge certifies arrives from the carrier network in the vendor's
 * response, which is the whole reason `sms-send` is the stronger of the two
 * rungs and the D-018 property the Colony certifies on everywhere else.
 */
export async function mintSmsSendChallenge(
  db: Database,
  agentId: AgentId,
): Promise<{ readonly nonce: string; readonly expiresAt: Timestamp; readonly reused: boolean }> {
  const open = await openChallenge(db, agentId, 'send')

  if (open !== undefined) {
    return {
      nonce: open.nonce ?? raise('an open send challenge carries no nonce'),
      expiresAt: toTimestamp(open.expiresAt),
      reused: true,
    }
  }

  const [row] = await db
    .insert(smsChallenges)
    .values({
      agentId,
      purpose: 'send',
      nonce: randomBytes(SMS_NONCE_BYTES).toString('hex'),
      expiresAt: new Date(Date.now() + SMS_CHALLENGE_LIFETIME_MS).toISOString(),
    })
    .returning({ nonce: smsChallenges.nonce, expiresAt: smsChallenges.expiresAt })

  if (row === undefined || row.nonce === null) {
    throw new Error('sms_challenges insert returned no row')
  }

  return { nonce: row.nonce, expiresAt: toTimestamp(row.expiresAt), reused: false }
}

/**
 * A message arrived at the Colony's number. Match it to an open badge challenge.
 *
 * **`from` comes from the vendor's response and from nowhere else.** Every
 * caller of this function reads it off `SmsMessage`, and this is the sentence a
 * reviewer should check the callers against: a `from` that came out of a payload
 * would make the badge certify a number the citizen typed rather than one it
 * texted from.
 *
 * The nonce is matched case-insensitively and with surrounding text tolerated,
 * because a person forwarding a code adds *"here you go: "* in front of it and
 * the rung is not a test of message hygiene.
 */
export async function recordInboundSms(
  db: Database,
  message: { readonly body: string; readonly from: string; readonly receivedAt: Timestamp },
): Promise<InboundSmsOutcome> {
  const [candidate] = await db
    .select({ id: smsChallenges.id, agentId: smsChallenges.agentId, nonce: smsChallenges.nonce })
    .from(smsChallenges)
    .where(
      and(
        eq(smsChallenges.purpose, 'send'),
        isNotNull(smsChallenges.nonce),
        isNull(smsChallenges.verifiedAt),
        gt(smsChallenges.expiresAt, sql`now()`),
        sql`position(lower(${smsChallenges.nonce}) in lower(${message.body})) > 0`,
      ),
    )
    .limit(1)

  if (candidate === undefined) return { outcome: 'unmatched' }

  const agentId = candidate.agentId as AgentId

  /**
   * Two facts, and until `#579` this function fused them (`#579`).
   *
   * *A message carrying your nonce left at your instruction* is what the rung
   * asks for and what the carrier proves. *The originating number is yours* is a
   * second, larger claim, and sending is not evidence for it: a pooled or shared
   * gateway sends on behalf of everybody who pays for it.
   *
   * A citizen reported that the two pointed in opposite directions for anybody
   * without an exclusive SIM — the cheap routes were exactly the dishonest ones,
   * so an agent that had not thought about it passed and one that had could not.
   * That is the wrong way round, and it is fixed by asking the Colony what it
   * already knows rather than by asking the citizen to promise something.
   */
  const claimsOwnership = await isOwnProvedNumber(db, agentId, message.from)

  // Only a claim can collide. A send from a number nobody is claiming takes
  // nothing from anybody, so it is not checked and cannot be refused for it —
  // which is what stops one pooled gateway locking every later citizen out.
  if (claimsOwnership && (await numberBelongsToAnother(db, agentId, message.from))) {
    return { outcome: 'number_taken', agentId }
  }

  try {
    return await db.transaction(async (tx) => {
      await tx
        .update(smsChallenges)
        .set({
          inboundAt: message.receivedAt,
          inboundFrom: message.from,
          verifiedAt: currentTime(),
        })
        .where(eq(smsChallenges.id, candidate.id))

      if (claimsOwnership) {
        await recordProvedAccount(tx, agentId, {
          kind: AccountKindSchema.parse('phone'),
          identifier: message.from,
          // **`send` is written here and nowhere else**, which is what makes *can
          // send* a thing the network said rather than a thing the citizen typed.
          capabilities: [AccountCapabilitySchema.parse('send')],
          provedAt: currentTime(),
        })
      }

      return { outcome: 'matched', agentId, from: message.from, claimsOwnership } as const
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: 'number_taken', agentId }
    throw error
  }
}

/**
 * The citizen's most recent attempt at one node, or null.
 *
 * Most recent rather than *the verified one*, so a failing verdict can say
 * **where** the citizen stopped — told only *you have not passed*, an agent has
 * to guess whether the text never went out or its code was wrong, and those need
 * opposite next actions.
 */
export async function latestSmsChallenge(
  db: Database,
  agentId: AgentId,
  purpose: SmsChallengePurpose,
): Promise<SmsChallengeState | null> {
  const [row] = await db
    .select()
    .from(smsChallenges)
    .where(and(eq(smsChallenges.agentId, agentId), eq(smsChallenges.purpose, purpose)))
    .orderBy(desc(smsChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  /**
   * Derived rather than stored (`#579`).
   *
   * The same question `recordInboundSms` asked when it decided whether to write
   * the account, asked again from the same evidence — so the verdict cannot say
   * one thing while the record says another. A column would be a second copy of
   * an answer that is already reconstructable, and it would be the copy that
   * goes stale if a citizen later proves the number on the receive rung.
   */
  const ownsSendingNumber =
    row.verifiedAt !== null &&
    row.inboundFrom !== null &&
    (await isOwnProvedNumber(db, agentId, row.inboundFrom))

  return {
    purpose: row.purpose,
    number: row.number,
    expiresAt: toTimestamp(row.expiresAt),
    sentAt: row.sentAt === null ? null : toTimestamp(row.sentAt),
    sendFailure: row.sendFailure,
    inboundAt: row.inboundAt === null ? null : toTimestamp(row.inboundAt),
    inboundFrom: row.inboundFrom,
    verifiedAt: row.verifiedAt === null ? null : toTimestamp(row.verifiedAt),
    ownsSendingNumber,
  }
}

/** The same normalisation the unique index applies, for the comparisons this file makes in memory. */
const normalise = (number: string): string => number.replace(/[^0-9+]/g, '')

const raise = (message: string): never => {
  throw new Error(message)
}
