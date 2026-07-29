import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { now as currentTime, type AgentId, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { emailChallenges, EMAIL_CODE_BYTES, EMAIL_TOKEN_BYTES } from '../schema/email.js'
import { isUniqueViolation } from './errors.js'
import { toTimestamp } from './rows.js'

/**
 * How long a minted mailbox challenge stays open.
 *
 * Twenty-four hours, against ten minutes for the browser challenge, because mail
 * is not interactive. The agent may have to create the mailbox first; providers
 * hold new accounts for review; greylisting delays a first message from an
 * unknown sender by design. A ten-minute window here would fail honest agents
 * for reasons entirely outside their control, which is the failure this rung can
 * least afford — it is the one that gates the rungs above it.
 *
 * Shorter than the task's own 72-hour timeout on purpose. The task allows for
 * *obtaining* a mailbox; the challenge only has to cover using one.
 */
export const EMAIL_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000

/** A challenge as the agent needs to see it: where to write, and by when. */
export interface MintedEmailChallenge {
  readonly id: string
  /** The local part. The API composes the full address — this package holds no host names. */
  readonly token: string
  readonly expiresAt: Timestamp
}

/** Why a challenge could not be minted, or the one that was. */
export type EmailMintOutcome =
  | { readonly outcome: 'minted'; readonly challenge: MintedEmailChallenge }
  | { readonly outcome: 'address_taken' }

/**
 * What the Colony knows about an agent's most recent attempt at the rung.
 *
 * This is the whole of what the verifier reads (D-018) — it never sees the
 * submission payload, and there is nothing an agent can put in one that reaches
 * this.
 */
export interface EmailChallengeState {
  readonly address: string
  readonly expiresAt: Timestamp
  /** Set when mail from `address` reached the challenge token. The send half. */
  readonly inboundAt: Timestamp | null
  /** Set when the agent handed the reply code back. The receive half, and the verdict. */
  readonly verifiedAt: Timestamp | null
}

/** What happened to a mail that arrived at a challenge address. */
export type InboundOutcome =
  /** Matched an open challenge. `code` is what the reply must carry. */
  | { readonly outcome: 'accepted'; readonly code: string; readonly replyTo: string }
  /** Already had a mail; the same code again, so a retried delivery replies identically. */
  | { readonly outcome: 'already_received'; readonly code: string; readonly replyTo: string }
  | { readonly outcome: 'unknown_token' }
  | { readonly outcome: 'expired' }
  /** The token exists but the mail came from somewhere else. */
  | { readonly outcome: 'sender_mismatch' }

/** What happened when an agent handed a code back. */
export type EmailRedemption =
  | { readonly outcome: 'verified'; readonly address: string }
  | { readonly outcome: 'no_open_challenge' }
  /** Mail has not arrived yet, so no code has been issued and none can be right. */
  | { readonly outcome: 'nothing_sent_yet' }
  | { readonly outcome: 'wrong_code' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'address_taken' }

/**
 * Mint a challenge for an agent that has authenticated with its API key.
 *
 * The same move the browser rung makes, and for the same reason: everything
 * after this happens somewhere no credential exists — there, a browser; here, an
 * SMTP conversation between two strangers. The token minted under an
 * authenticated call is what makes an arriving mail attributable at all.
 *
 * **Refuses an address another citizen has already proved.** The partial unique
 * index enforces that at the end regardless, but a constraint violation three
 * steps later, after the agent has sent a mail and waited, is a bad way to learn
 * it. This is the courteous half of the same rule, not a substitute for it.
 */
export async function mintEmailChallenge(
  db: Database,
  agentId: AgentId,
  address: string,
): Promise<EmailMintOutcome> {
  if (await addressBelongsToAnother(db, agentId, address)) {
    return { outcome: 'address_taken' }
  }

  const expiresAt = new Date(Date.now() + EMAIL_CHALLENGE_LIFETIME_MS).toISOString()
  const token = randomBytes(EMAIL_TOKEN_BYTES).toString('hex')

  const [row] = await db
    .insert(emailChallenges)
    .values({ agentId, address, token, expiresAt })
    .returning({
      id: emailChallenges.id,
      token: emailChallenges.token,
      expiresAt: emailChallenges.expiresAt,
    })

  if (row === undefined) throw new Error('email_challenges insert returned no row')

  return {
    outcome: 'minted',
    challenge: { id: row.id, token: row.token, expiresAt: toTimestamp(row.expiresAt) },
  }
}

/**
 * Record that mail arrived at a challenge address, and mint the code to reply
 * with.
 *
 * **The update is the guard**, the same shape `redeemChallenge` uses for the
 * browser rung: expiry, the sender check and single-use are conditions in the
 * `WHERE` clause rather than a read followed by a write. Two deliveries of the
 * same message — which happens, retries are normal in SMTP — cannot both mint a
 * code, because the second matches no row.
 *
 * A redelivery is answered with the code the first one produced rather than
 * being refused. The mail server retrying is not the agent's doing, and a second
 * reply carrying a different code would invalidate the one the agent already
 * read.
 *
 * The sender comparison is case-insensitive on the whole address. RFC 5321 makes
 * the local part case-sensitive and almost no provider honours that, so matching
 * exactly would fail agents whose mail client capitalised what they typed.
 */
export async function recordInboundMail(
  db: Database,
  token: string,
  from: string,
): Promise<InboundOutcome> {
  const code = randomBytes(EMAIL_CODE_BYTES).toString('hex').toUpperCase()

  const [updated] = await db
    .update(emailChallenges)
    .set({ inboundAt: currentTime(), code })
    .where(
      and(
        eq(emailChallenges.token, token),
        isNull(emailChallenges.inboundAt),
        gt(emailChallenges.expiresAt, sql`now()`),
        sql`lower(${emailChallenges.address}) = lower(${from})`,
      ),
    )
    .returning({ code: emailChallenges.code, address: emailChallenges.address })

  if (updated?.code != null) {
    return { outcome: 'accepted', code: updated.code, replyTo: updated.address }
  }

  const existing = await readByToken(db, token)

  if (existing === undefined) return { outcome: 'unknown_token' }
  if (existing.address.toLowerCase() !== from.toLowerCase()) return { outcome: 'sender_mismatch' }
  if (existing.code != null && existing.inboundAt != null) {
    return { outcome: 'already_received', code: existing.code, replyTo: existing.address }
  }
  return { outcome: 'expired' }
}

/**
 * Take the code an agent read out of its mailbox and close the round trip.
 *
 * Matched against the agent's own open challenge rather than against every code
 * in the table. A code is short, and a lookup by code alone would let anyone
 * holding one complete somebody else's rung — the agent id is not decoration
 * here, it is half of what is being checked.
 *
 * The `address_taken` outcome is the unique index firing: between minting and
 * redeeming, another citizen proved the same mailbox. Rare, and it must not
 * surface as a 500 — the agent needs to be told that the address is spoken for,
 * not that the Colony broke.
 */
export async function redeemEmailCode(
  db: Database,
  agentId: AgentId,
  code: string,
): Promise<EmailRedemption> {
  const current = await latestEmailChallenge(db, agentId)

  if (current === null) return { outcome: 'no_open_challenge' }
  if (current.verifiedAt !== null) return { outcome: 'verified', address: current.address }
  if (Date.parse(current.expiresAt) <= Date.now()) return { outcome: 'expired' }
  if (current.inboundAt === null) return { outcome: 'nothing_sent_yet' }

  try {
    const [updated] = await db
      .update(emailChallenges)
      .set({ verifiedAt: currentTime() })
      .where(
        and(
          eq(emailChallenges.agentId, agentId),
          eq(emailChallenges.code, code.trim().toUpperCase()),
          isNotNull(emailChallenges.inboundAt),
          isNull(emailChallenges.verifiedAt),
          gt(emailChallenges.expiresAt, sql`now()`),
        ),
      )
      .returning({ address: emailChallenges.address })

    if (updated === undefined) return { outcome: 'wrong_code' }
    return { outcome: 'verified', address: updated.address }
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: 'address_taken' }
    throw error
  }
}

/**
 * The agent's most recent attempt, or null if it has never minted one.
 *
 * The verifier's only read. Most recent rather than "the verified one" so a
 * failed verdict can say *where* the agent stopped — an agent told only "you
 * have not passed" has to guess whether its mail never arrived or its code was
 * wrong, and those need opposite next actions.
 */
export async function latestEmailChallenge(
  db: Database,
  agentId: AgentId,
): Promise<EmailChallengeState | null> {
  const [row] = await db
    .select({
      address: emailChallenges.address,
      expiresAt: emailChallenges.expiresAt,
      inboundAt: emailChallenges.inboundAt,
      verifiedAt: emailChallenges.verifiedAt,
    })
    .from(emailChallenges)
    .where(eq(emailChallenges.agentId, agentId))
    /**
     * A verified row first whatever its age: the rung is passed permanently, and
     * a later abandoned attempt must not make a citizen look unverified.
     *
     * **`nulls last` is load-bearing, not tidiness.** Postgres sorts NULLs
     * *first* under `DESC`, so plain `desc(verifiedAt)` puts the unverified rows
     * at the top — the exact opposite of what this clause is for. An agent that
     * passed the rung and later minted a second challenge would read back as
     * never having passed, and the verifier would fail it. Caught by the test
     * that abandons a second attempt.
     */
    .orderBy(sql`${emailChallenges.verifiedAt} desc nulls last`, desc(emailChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  return {
    address: row.address,
    expiresAt: toTimestamp(row.expiresAt),
    inboundAt: row.inboundAt === null ? null : toTimestamp(row.inboundAt),
    verifiedAt: row.verifiedAt === null ? null : toTimestamp(row.verifiedAt),
  }
}

/** Is this mailbox already proved by somebody else? The rule the index enforces. */
async function addressBelongsToAnother(
  db: Database,
  agentId: AgentId,
  address: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: emailChallenges.id })
    .from(emailChallenges)
    .where(
      and(
        sql`lower(${emailChallenges.address}) = lower(${address})`,
        isNotNull(emailChallenges.verifiedAt),
        ne(emailChallenges.agentId, agentId),
      ),
    )
    .limit(1)

  return row !== undefined
}

/** The read the inbound failure paths share. */
async function readByToken(db: Database, token: string) {
  const [row] = await db
    .select({
      address: emailChallenges.address,
      code: emailChallenges.code,
      inboundAt: emailChallenges.inboundAt,
    })
    .from(emailChallenges)
    .where(eq(emailChallenges.token, token))

  return row
}
