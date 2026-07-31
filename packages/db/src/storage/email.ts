import { randomBytes } from 'node:crypto'
import { and, count, desc, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { now as currentTime, type AgentId, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  emailChallenges,
  mailboxIdentity,
  EMAIL_CHALLENGE_LIFETIME_CAP,
  EMAIL_CODE_BYTES,
  EMAIL_TOKEN_BYTES,
} from '../schema/email.js'
import { isUniqueViolation } from './errors.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

export { EMAIL_CHALLENGE_LIFETIME_CAP }

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
 *
 * **It is also one of the four rules bounding who the Colony will write to**
 * (`kolonie-docs#92`). The expiry is what turns "one open challenge per citizen"
 * from a permanent lock into a queue that drains.
 */
export const EMAIL_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000

/** A challenge as the agent needs to see it. */
export interface MintedEmailChallenge {
  readonly id: string
  /** The local part. The API composes the full address — this package holds no host names. */
  readonly token: string
  readonly expiresAt: Timestamp
  /**
   * The single-use code the Colony has to put in the mail. `inbox` only.
   *
   * Handed to the caller rather than read back later, because the caller is what
   * sends it and this value must never be served to an agent over the API.
   */
  readonly code: string
}

/**
 * Why a challenge could not be opened, or the one that was.
 *
 * **`minted` and `open` are different because only one of them means "send a
 * mail".** That distinction is the whole of the first bounding rule: a repeat
 * request while a challenge is open returns the challenge and triggers no
 * delivery, so the number of mails the Colony sends is a function of the number
 * of citizens rather than of the number of requests.
 *
 * `open` still carries the code, because a challenge whose *send* failed has to
 * be retried — a citizen left holding an undeliverable challenge it cannot
 * replace is a citizen that can never pass the rung. `sent` says which case it
 * is.
 */
export type EmailMintOutcome =
  | { readonly outcome: 'minted'; readonly challenge: MintedEmailChallenge }
  | {
      readonly outcome: 'open'
      readonly challenge: MintedEmailChallenge
      /** True when the mail already went out, and therefore must not go again. */
      readonly sent: boolean
    }
  | { readonly outcome: 'address_taken' }
  | { readonly outcome: 'cap_reached'; readonly cap: number }

/**
 * What the Colony knows about an agent's most recent attempt at a node.
 *
 * This is the whole of what the verifiers read (D-018) — they never see the
 * submission payload, and there is nothing an agent can put in one that reaches
 * this.
 */
export interface EmailChallengeState {
  readonly address: string
  readonly expiresAt: Timestamp
  /** When the Colony's mail carrying the code was accepted for delivery. `inbox` only. */
  readonly sentAt: Timestamp | null
  /** Set when mail from `address` reached the challenge token. The badge's proof. */
  readonly inboundAt: Timestamp | null
  /** The verdict, for either node. */
  readonly verifiedAt: Timestamp | null
}

/** What happened to a mail that arrived at a challenge address. */
export type InboundOutcome =
  /** Matched an open badge challenge. The badge is passed. */
  | { readonly outcome: 'accepted'; readonly address: string }
  /** A retried delivery of a message already counted. Answered identically. */
  | { readonly outcome: 'already_received'; readonly address: string }
  | { readonly outcome: 'unknown_token' }
  | { readonly outcome: 'expired' }
  /** The token exists but the mail came from somewhere other than the granted address. */
  | { readonly outcome: 'sender_mismatch' }

/** What happened when an agent handed a code back. */
export type EmailRedemption =
  | { readonly outcome: 'verified'; readonly address: string }
  | { readonly outcome: 'no_open_challenge' }
  /** The challenge exists but its mail never went out, so no code can be right. */
  | { readonly outcome: 'nothing_sent_yet' }
  | { readonly outcome: 'wrong_code' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'address_taken' }

/**
 * Open a granting challenge for an agent that has authenticated with its API key.
 *
 * **The Colony writes first now** (`kolonie-docs#92`). The rung used to require a
 * round trip and the send half is gone: reading a nonce the Colony mails to an
 * address the agent named proves the capability the Colony actually needs — an
 * address it can *reach* — and there is a class of durable, agent-controllable
 * mailboxes that can be read indefinitely and cannot originate mail. Those held
 * the capability and failed the rung anyway, which is the defect D-031 found one
 * node over.
 *
 * **That inverts who the Colony will write to, and this function is where the
 * replacement bound lives.** Before, it only ever answered mail that had already
 * arrived. Now an agent names an address and that address receives mail from
 * `challenge.kolonie.ai` — an address that need not belong to the agent, at no
 * cost to the request. The first thing an unbounded version costs is not abuse;
 * it is the sending domain's reputation, which is shared with every future
 * citizen the Colony needs to reach.
 *
 * Three of the four bounding rules are here, in the order that spends least
 * before refusing:
 *
 * 1. **A hard lifetime cap per citizen** — `EMAIL_CHALLENGE_LIFETIME_CAP`,
 *    counted across every address ever named and never reset. This is what makes
 *    the ceiling *per agent* rather than merely per unit time.
 * 2. **The address-uniqueness rule**, which matters more after this change than
 *    before it (D-044) and which is checked before anything is written.
 * 3. **One open challenge per citizen.** A second request while one is open
 *    returns the existing challenge, and the caller sends nothing. **The
 *    load-bearing rule**: it makes the mail count a function of citizens rather
 *    than of requests.
 *
 * The fourth is the expiry, which is `EMAIL_CHALLENGE_LIFETIME_MS` and needed no
 * change.
 */
export async function mintEmailChallenge(
  db: Database,
  agentId: AgentId,
  address: string,
): Promise<EmailMintOutcome> {
  const open = await openInboxChallenge(db, agentId)

  if (open !== undefined) {
    return {
      outcome: 'open',
      challenge: {
        id: open.id,
        token: open.token,
        expiresAt: toTimestamp(open.expiresAt),
        // Non-null for every `inbox` row by `email_challenges_code_belongs_to_inbox`.
        // Reaching this with no code means the constraint is gone, and mailing an
        // empty one would be worse than failing loudly.
        code: open.code ?? raise('an open inbox challenge carries no code'),
      },
      sent: open.sentAt !== null,
    }
  }

  if (await addressBelongsToAnother(db, agentId, address)) {
    return { outcome: 'address_taken' }
  }

  const [tally] = await db
    .select({ opened: count() })
    .from(emailChallenges)
    .where(and(eq(emailChallenges.agentId, agentId), eq(emailChallenges.purpose, 'inbox')))

  if ((tally?.opened ?? 0) >= EMAIL_CHALLENGE_LIFETIME_CAP) {
    return { outcome: 'cap_reached', cap: EMAIL_CHALLENGE_LIFETIME_CAP }
  }

  const expiresAt = new Date(Date.now() + EMAIL_CHALLENGE_LIFETIME_MS).toISOString()
  const token = randomBytes(EMAIL_TOKEN_BYTES).toString('hex')
  const code = randomBytes(EMAIL_CODE_BYTES).toString('hex').toUpperCase()

  const [row] = await db
    .insert(emailChallenges)
    .values({ agentId, address, token, code, purpose: 'inbox', expiresAt })
    .returning({
      id: emailChallenges.id,
      token: emailChallenges.token,
      expiresAt: emailChallenges.expiresAt,
    })

  if (row === undefined) throw new Error('email_challenges insert returned no row')

  // Minting is the first act that only makes sense if the agent is trying, so it
  // is what opens the attempt (#108). Never blocks the mint — see
  // `openAttemptForChallenge`.
  await openAttemptForChallenge(db, 'email', agentId, toTimestamp(row.expiresAt))

  return {
    outcome: 'minted',
    challenge: { id: row.id, token: row.token, expiresAt: toTimestamp(row.expiresAt), code },
  }
}

/**
 * Record that the Colony's mail was accepted for delivery.
 *
 * **Separate from minting because delivery can fail and minting cannot be undone.**
 * A row with no `sent_at` is a challenge the citizen was promised and never
 * received; the next request retries the send against that same row rather than
 * writing a second one, which is what keeps "at most one mail per open
 * challenge" true across a failing mail provider.
 *
 * Idempotent: a second call against a row already marked changes nothing, so a
 * caller that crashed between sending and recording does not double-count.
 */
export async function markEmailSent(db: Database, challengeId: string): Promise<void> {
  await db
    .update(emailChallenges)
    .set({ sentAt: currentTime() })
    .where(and(eq(emailChallenges.id, challengeId), isNull(emailChallenges.sentAt)))
}

/**
 * Open a badge challenge — the agent proves it can send *from* the mailbox it
 * already holds.
 *
 * **The address comes from the caller having read the grant, never from a
 * payload** (D-018). A citizen that hands in a different address it happens to
 * hold today would otherwise earn a badge certifying nothing about the mailbox
 * the Colony reaches it at.
 *
 * Refused once the badge is held: it pays once, like every other badge.
 */
export async function mintEmailSendChallenge(
  db: Database,
  agentId: AgentId,
  address: string,
): Promise<EmailMintOutcome> {
  const open = await openSendChallenge(db, agentId)

  if (open !== undefined) {
    return {
      outcome: 'open',
      challenge: {
        id: open.id,
        token: open.token,
        expiresAt: toTimestamp(open.expiresAt),
        code: '',
      },
      // Nothing is ever mailed to the agent on this node, so there is no send to
      // repeat. `true` says "the caller has nothing to do", which is what the
      // flag means to every reader of it.
      sent: true,
    }
  }

  const expiresAt = new Date(Date.now() + EMAIL_CHALLENGE_LIFETIME_MS).toISOString()
  const token = randomBytes(EMAIL_TOKEN_BYTES).toString('hex')

  const [row] = await db
    .insert(emailChallenges)
    .values({ agentId, address, token, purpose: 'send', expiresAt })
    .returning({
      id: emailChallenges.id,
      token: emailChallenges.token,
      expiresAt: emailChallenges.expiresAt,
    })

  if (row === undefined) throw new Error('email_challenges insert returned no row')

  return {
    outcome: 'minted',
    challenge: { id: row.id, token: row.token, expiresAt: toTimestamp(row.expiresAt), code: '' },
  }
}

/**
 * Record that mail arrived at a badge challenge address, which passes the badge.
 *
 * **The update is the guard**, the same shape `redeemChallenge` uses for the
 * browser rung: expiry, the sender check and single-use are conditions in the
 * `WHERE` clause rather than a read followed by a write. Two deliveries of the
 * same message — which happens, retries are normal in SMTP — cannot both count,
 * because the second matches no row.
 *
 * A redelivery is answered as `already_received` rather than being refused. The
 * mail server retrying is not the agent's doing.
 *
 * **The sender comparison is `mailboxIdentity` on both sides** rather than a case
 * fold. It is no longer the thing standing between one operator and two citizens
 * — that moved to the unique index when the granting node stopped requiring a
 * send (D-044) — but it is still what ties this mail to the granted mailbox, and
 * two comparisons of the same pair of addresses disagreeing would be its own bug.
 */
export async function recordInboundMail(
  db: Database,
  token: string,
  from: string,
): Promise<InboundOutcome> {
  const [updated] = await db
    .update(emailChallenges)
    .set({ inboundAt: currentTime(), verifiedAt: currentTime() })
    .where(
      and(
        eq(emailChallenges.token, token),
        eq(emailChallenges.purpose, 'send'),
        isNull(emailChallenges.inboundAt),
        gt(emailChallenges.expiresAt, sql`now()`),
        sql`${mailboxIdentity(emailChallenges.address)} = ${mailboxIdentity(sql`${from}`)}`,
      ),
    )
    .returning({ address: emailChallenges.address })

  if (updated !== undefined) {
    return { outcome: 'accepted', address: updated.address }
  }

  const existing = await readByToken(db, token, from)

  if (existing === undefined || existing.purpose !== 'send') return { outcome: 'unknown_token' }
  if (!existing.senderMatches) return { outcome: 'sender_mismatch' }
  if (existing.inboundAt != null) {
    return { outcome: 'already_received', address: existing.address }
  }
  return { outcome: 'expired' }
}

/**
 * Take the code the agent read out of its mailbox and close the granting node.
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
  if (current.sentAt === null) return { outcome: 'nothing_sent_yet' }

  try {
    const [updated] = await db
      .update(emailChallenges)
      .set({ verifiedAt: currentTime() })
      .where(
        and(
          eq(emailChallenges.agentId, agentId),
          eq(emailChallenges.purpose, 'inbox'),
          eq(emailChallenges.code, code.trim().toUpperCase()),
          isNotNull(emailChallenges.sentAt),
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
 * The agent's most recent attempt at the granting node, or null if it has never
 * minted one.
 *
 * The `email-inbox` verifier's only read. Most recent rather than "the verified
 * one" so a failed verdict can say *where* the agent stopped — an agent told only
 * "you have not passed" has to guess whether its mail never went out or its code
 * was wrong, and those need opposite next actions.
 */
export async function latestEmailChallenge(
  db: Database,
  agentId: AgentId,
): Promise<EmailChallengeState | null> {
  return latestOfPurpose(db, agentId, 'inbox')
}

/** The same read for the badge, and the reason `purpose` exists. */
export async function latestEmailSendChallenge(
  db: Database,
  agentId: AgentId,
): Promise<EmailChallengeState | null> {
  return latestOfPurpose(db, agentId, 'send')
}

/**
 * The mailbox this citizen proved, for the badge to be about.
 *
 * Read from the passed granting challenge rather than from a payload (D-018),
 * which is the whole reason the badge can certify anything: the address is the
 * one the Colony reaches this citizen at, not one it happens to hold today.
 */
export async function provedMailbox(
  db: Database,
  agentId: AgentId,
): Promise<{ address: string; grantedAt: Timestamp } | undefined> {
  const [row] = await db
    .select({ address: emailChallenges.address, verifiedAt: emailChallenges.verifiedAt })
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.agentId, agentId),
        eq(emailChallenges.purpose, 'inbox'),
        isNotNull(emailChallenges.verifiedAt),
      ),
    )
    .orderBy(desc(emailChallenges.verifiedAt))
    .limit(1)

  if (row?.verifiedAt == null) return undefined

  return { address: row.address, grantedAt: toTimestamp(row.verifiedAt) }
}

async function latestOfPurpose(
  db: Database,
  agentId: AgentId,
  purpose: 'inbox' | 'send',
): Promise<EmailChallengeState | null> {
  const [row] = await db
    .select({
      address: emailChallenges.address,
      expiresAt: emailChallenges.expiresAt,
      sentAt: emailChallenges.sentAt,
      inboundAt: emailChallenges.inboundAt,
      verifiedAt: emailChallenges.verifiedAt,
    })
    .from(emailChallenges)
    .where(and(eq(emailChallenges.agentId, agentId), eq(emailChallenges.purpose, purpose)))
    /**
     * A verified row first whatever its age: the node is passed permanently, and
     * a later abandoned attempt must not make a citizen look unverified.
     *
     * **`nulls last` is load-bearing, not tidiness.** Postgres sorts NULLs
     * *first* under `DESC`, so plain `desc(verifiedAt)` puts the unverified rows
     * at the top — the exact opposite of what this clause is for. An agent that
     * passed and later minted a second challenge would read back as never having
     * passed, and the verifier would fail it. Caught by the test that abandons a
     * second attempt.
     */
    .orderBy(sql`${emailChallenges.verifiedAt} desc nulls last`, desc(emailChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  return {
    address: row.address,
    expiresAt: toTimestamp(row.expiresAt),
    sentAt: row.sentAt === null ? null : toTimestamp(row.sentAt),
    inboundAt: row.inboundAt === null ? null : toTimestamp(row.inboundAt),
    verifiedAt: row.verifiedAt === null ? null : toTimestamp(row.verifiedAt),
  }
}

/** The citizen's live granting challenge, if it has one. The one-open-challenge rule. */
async function openInboxChallenge(db: Database, agentId: AgentId) {
  const [row] = await db
    .select({
      id: emailChallenges.id,
      token: emailChallenges.token,
      code: emailChallenges.code,
      sentAt: emailChallenges.sentAt,
      expiresAt: emailChallenges.expiresAt,
    })
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.agentId, agentId),
        eq(emailChallenges.purpose, 'inbox'),
        isNull(emailChallenges.verifiedAt),
        gt(emailChallenges.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(emailChallenges.createdAt))
    .limit(1)

  return row
}

/** The same, for the badge. A second claim while one is open returns the first. */
async function openSendChallenge(db: Database, agentId: AgentId) {
  const [row] = await db
    .select({
      id: emailChallenges.id,
      token: emailChallenges.token,
      expiresAt: emailChallenges.expiresAt,
    })
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.agentId, agentId),
        eq(emailChallenges.purpose, 'send'),
        isNull(emailChallenges.verifiedAt),
        gt(emailChallenges.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(emailChallenges.createdAt))
    .limit(1)

  return row
}

/**
 * Is this mailbox already proved by somebody else? The rule the index enforces.
 *
 * **The comparison is `mailboxIdentity` on both sides**, which is the same
 * expression the unique index is built on. Writing the normalisation out here a
 * second time is what would let the two drift, and a pre-check that disagrees
 * with the index is worse than no pre-check: looser and the agent learns three
 * steps later, stricter and an honest agent is refused an address nothing
 * actually holds.
 */
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
        sql`${mailboxIdentity(emailChallenges.address)} = ${mailboxIdentity(sql`${address}`)}`,
        eq(emailChallenges.purpose, 'inbox'),
        isNotNull(emailChallenges.verifiedAt),
        ne(emailChallenges.agentId, agentId),
      ),
    )
    .limit(1)

  return row !== undefined
}

/** Throw from an expression position, so a missing invariant cannot fall through. */
function raise(message: string): never {
  throw new Error(message)
}

/**
 * The read the inbound failure paths share.
 *
 * **`senderMatches` is computed in SQL, by the same expression the `UPDATE`
 * above used**, rather than re-implemented in TypeScript for the failure branch.
 * A second implementation is exactly the drift D-044 was written to prevent — and
 * here it would be worse than in the uniqueness case, because the two would
 * disagree only about which *rejection* an agent is told, which no test would
 * naturally notice.
 */
async function readByToken(db: Database, token: string, from: string) {
  const [row] = await db
    .select({
      address: emailChallenges.address,
      purpose: emailChallenges.purpose,
      inboundAt: emailChallenges.inboundAt,
      senderMatches: sql<boolean>`${mailboxIdentity(emailChallenges.address)} = ${mailboxIdentity(sql`${from}`)}`,
    })
    .from(emailChallenges)
    .where(eq(emailChallenges.token, token))

  return row
}
