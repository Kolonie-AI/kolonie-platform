import { randomBytes } from 'node:crypto'
import { and, count, desc, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import {
  AccountCapabilitySchema,
  AccountKindSchema,
  AgentIdSchema,
  now as currentTime,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  emailChallenges,
  mailboxIdentity,
  EMAIL_CHALLENGE_LIFETIME_CEILING,
  EMAIL_CHALLENGE_WINDOW_CAP,
  EMAIL_CHALLENGE_WINDOW_MS,
  EMAIL_CODE_BYTES,
  EMAIL_TOKEN_BYTES,
} from '../schema/email.js'
import { recordProvedAccount } from './accounts.js'
import { isUniqueViolation } from './errors.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

export { EMAIL_CHALLENGE_LIFETIME_CEILING, EMAIL_CHALLENGE_WINDOW_CAP, EMAIL_CHALLENGE_WINDOW_MS }

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
      /** The address the open challenge was opened against. */
      readonly address: string
      /**
       * Whether that address is the mailbox the caller just named (#157).
       *
       * **Decided here rather than by the caller, because the rule is
       * `mailboxIdentity` and it exists once, in SQL.** A `===` in the API would
       * be a second implementation of *what counts as the same inbox* — the one
       * the unique index, the sender check and `addressBelongsToAnother` all
       * share — and the two would disagree the first time somebody asked again
       * with a `+tag` or a capital letter.
       *
       * It matters because one open challenge per citizen means a second request
       * naming a *different* mailbox cannot be honoured: the code belongs to the
       * first address, and sending it to the second would prove control of one
       * mailbox and credit another.
       */
      readonly matchesRequested: boolean
      /** True when the mail already went out, and therefore must not go again. */
      readonly sent: boolean
    }
  | { readonly outcome: 'address_taken' }
  /**
   * The rolling window is full, and this says when it will not be (`#153`).
   *
   * **Distinct from the ceiling because the two are different situations and
   * only one of them is recoverable.** A citizen at the window has to wait; a
   * citizen at the ceiling has to talk to somebody. Answering both with one
   * outcome meant the common, temporary case was told the permanent one's
   * story — which is the failure this split exists to end.
   */
  | {
      readonly outcome: 'window_reached'
      readonly limits: EmailChallengeLimits
      /** When the oldest counted challenge leaves the window and a slot frees. */
      readonly retryAfter: Timestamp
    }
  | { readonly outcome: 'ceiling_reached'; readonly limits: EmailChallengeLimits }

/**
 * What bounds this citizen's granting challenges, and how much of it is spent.
 *
 * **Served rather than only documented** (`#153`). The task text used to quote
 * the number, and a text quoting a figure that configuration can change is a
 * text that goes wrong silently — it keeps reading correctly and stops being
 * true. So the numbers live in one place, the citizen can read them at any time,
 * and the prose says only that a bound exists.
 */
export interface EmailChallengeLimits {
  /** How many may be opened inside {@link windowMs}. */
  readonly windowCap: number
  readonly windowMs: number
  /** How many may ever be opened, across the citizen's whole life. */
  readonly ceiling: number
  /** Opened inside the current window. */
  readonly openedInWindow: number
  /** Opened ever, which is what the ceiling counts. */
  readonly openedEver: number
  /**
   * When a slot frees, or null while one is free now.
   *
   * Null also when the ceiling is what is in the way, because nothing frees
   * then and a time here would be a promise the Colony cannot keep.
   */
  readonly nextAvailableAt: Timestamp | null
}

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
 * 1. **A rolling window per citizen, and a lifetime ceiling above it** —
 *    `EMAIL_CHALLENGE_WINDOW_CAP` inside `EMAIL_CHALLENGE_WINDOW_MS`, and
 *    `EMAIL_CHALLENGE_LIFETIME_CEILING` across the citizen's whole life. The
 *    window bounds what the sending domain is exposed to at any moment; the
 *    ceiling is the backstop against grinding slowly. This was one lifetime cap
 *    of five until `#153`, which made a legitimate second or third mailbox
 *    impossible for the rest of a citizen's life — the register (`#150`) makes
 *    holding several the ordinary case, and a bound that never heals stood in
 *    front of it.
 * 2. **The address-uniqueness rule**, which matters more after this change than
 *    before it (D-044) and which is checked before anything is written.
 * 3. **One open challenge per citizen.** A second request while one is open
 *    returns the existing challenge, and the caller sends nothing. **The
 *    load-bearing rule**: it makes the mail count a function of citizens rather
 *    than of requests. Untouched by `#153`, along with the uniqueness rule —
 *    those two are what make outbound mail a function of citizens rather than of
 *    requests, and neither had anything to do with the wall being removed.
 *
 * The fourth is the expiry, which is `EMAIL_CHALLENGE_LIFETIME_MS` and needed no
 * change.
 */
export async function mintEmailChallenge(
  db: Database,
  agentId: AgentId,
  address: string,
): Promise<EmailMintOutcome> {
  const open = await openInboxChallenge(db, agentId, address)

  if (open !== undefined) {
    return {
      outcome: 'open',
      address: open.address,
      matchesRequested: open.matchesRequested,
      challenge: {
        id: open.id,
        token: open.token,
        expiresAt: toTimestamp(open.expiresAt),
        // Non-null because `openInboxChallenge` selects on it. The constraint does
        // *not* give this — it permits a code-less row while nothing was sent, and
        // reading one as an open challenge is exactly what #157 was. Kept as an
        // assertion rather than a cast: mailing an empty code would be worse than
        // failing loudly, and this is the line that says so.
        code: open.code ?? raise('an open inbox challenge carries no code'),
      },
      sent: open.sentAt !== null,
    }
  }

  if (await addressBelongsToAnother(db, agentId, address)) {
    return { outcome: 'address_taken' }
  }

  // **Code-less rows do not count, for the same reason they do not block.** The
  // bound is on how many addresses the Colony agreed to write to; it never agreed
  // to write to a round-trip challenge, because that flow asked it to answer mail
  // rather than to send any. Counting them charges a citizen for requests the
  // Colony never spent anything on. Measured on the production database on
  // 2026-08-01 at 10:50 UTC, one citizen (`8af89ae8`) held 5 inbox rows, all 5
  // code-less and none verified — at the cap of 5, permanently, on the strength of
  // a mechanism that has been deleted.
  //
  // Where that rule lives is `countedChallenges` below, once, so the refusal and
  // the number the citizen reads can never disagree about which rows are a
  // mailing.
  const limits = await emailChallengeLimits(db, agentId)

  if (limits.openedEver >= EMAIL_CHALLENGE_LIFETIME_CEILING) {
    return { outcome: 'ceiling_reached', limits }
  }

  if (limits.openedInWindow >= EMAIL_CHALLENGE_WINDOW_CAP) {
    // Non-null whenever the window is full: a full window has a counted row in
    // it, and `nextAvailableAt` is that row's creation plus the window. Stated
    // as an assertion rather than carried as an optional field, because a
    // refusal that cannot say when to ask again is the refusal `#153` set out to
    // remove.
    return {
      outcome: 'window_reached',
      limits,
      retryAfter: limits.nextAvailableAt ?? raise('a full window has no oldest challenge'),
    }
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
 * What bounds this citizen's granting challenges, and how much of it it has
 * spent (`#153`).
 *
 * **The read the refusal and the citizen share.** `mintEmailChallenge` decides
 * with it and the mailbox surface serves it, so what an agent is told before it
 * asks and what it is told when refused come from one query — a second
 * implementation of *which rows count* is exactly the drift that would let the
 * two disagree, and the disagreement would look like the Colony miscounting.
 *
 * Counts only rows that carry a code, which is the set the Colony actually
 * mailed something for. See `mintEmailChallenge` for why a code-less row is not
 * a mailing.
 */
export async function emailChallengeLimits(
  db: Database,
  agentId: AgentId,
): Promise<EmailChallengeLimits> {
  const windowStart = new Date(Date.now() - EMAIL_CHALLENGE_WINDOW_MS).toISOString()
  const inWindow = sql`${emailChallenges.createdAt} >= ${windowStart}`

  const [tally] = await db
    .select({
      openedEver: count(),
      // `cast(... as integer)` because a bare `count()` comes back from the
      // driver as a string, and a string that compares as a number until the
      // day it is 10 is the kind of bug this file can least afford.
      openedInWindow: sql<number>`cast(count(*) filter (where ${inWindow}) as integer)`,
      oldestInWindow: sql<
        string | null
      >`min(${emailChallenges.createdAt}) filter (where ${inWindow})`,
    })
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.agentId, agentId),
        eq(emailChallenges.purpose, 'inbox'),
        isNotNull(emailChallenges.code),
      ),
    )

  const openedInWindow = tally?.openedInWindow ?? 0
  const openedEver = tally?.openedEver ?? 0
  const oldest = tally?.oldestInWindow ?? null
  const atCeiling = openedEver >= EMAIL_CHALLENGE_LIFETIME_CEILING

  return {
    windowCap: EMAIL_CHALLENGE_WINDOW_CAP,
    windowMs: EMAIL_CHALLENGE_WINDOW_MS,
    ceiling: EMAIL_CHALLENGE_LIFETIME_CEILING,
    openedInWindow,
    openedEver,
    /**
     * **Only when the window is what is in the way.** A free slot has no next
     * time — the answer is *now* — and a citizen at the ceiling has none at all,
     * because nothing frees. Handing the ceiling case a date would be the Colony
     * promising something it will not do.
     */
    nextAvailableAt:
      atCeiling || openedInWindow < EMAIL_CHALLENGE_WINDOW_CAP || oldest === null
        ? null
        : toTimestamp(
            new Date(new Date(oldest).getTime() + EMAIL_CHALLENGE_WINDOW_MS).toISOString(),
          ),
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
      // Always the granted reach address on this node — the caller cannot name
      // another one, so unlike the inbox path there is nothing here to compare
      // it against. Carried rather than blanked, so the field means the same
      // thing in both variants.
      address: open.address,
      // True because there is no other answer available: this node reads the
      // address from the grant, so what was asked for and what is open cannot
      // differ. See `mintEmailSendChallenge`'s own comment on D-018.
      matchesRequested: true,
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
  /**
   * **The send half writes the register too, in the same transaction** (`#297`).
   *
   * `#289` did this for the inbox half and left this one to the `email-send`
   * badge's verdict, which is the same gap one capability over: a citizen
   * proving `send` for a *second* mailbox has already passed that badge, and
   * `#292` refuses a passed rung permanently — so nothing would ever record what
   * the Colony had just watched happen. Mail arriving from the address is the
   * proof; the verdict is a consequence of it.
   *
   * `recordProvedAccount` adds capabilities rather than replacing them, so a
   * later badge naming the same mailbox changes nothing and the `receive` this
   * address may already hold survives.
   */
  const updated = await db.transaction(async (tx) => {
    const [verified] = await tx
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
      .returning({ agentId: emailChallenges.agentId, address: emailChallenges.address })

    if (verified === undefined) return undefined

    await recordProvedAccount(tx, AgentIdSchema.parse(verified.agentId), {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: verified.address,
      // What mail arriving from the address demonstrates, and only that.
      // Receiving is the inbox half's to add and is deliberately not claimed.
      capabilities: [AccountCapabilitySchema.parse('send')],
      provedAt: currentTime(),
    })

    return verified
  })

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
  /**
   * **The citizen's open challenge, not its latest row** (`#136`).
   *
   * This read was `latestEmailChallenge`, which orders `verified_at desc nulls
   * last` — so once a citizen had passed, its verified row sorted *ahead* of any
   * challenge it opened afterwards, and this function returned
   * `{ outcome: 'verified' }` naming the old address without looking at the code
   * at all. A citizen proving a second mailbox was told it had succeeded, about
   * an address it had not just proved, while the new challenge stayed unverified
   * for ever.
   *
   * That is also why the defect `#136` describes never fired in production: the
   * moving reach address needed two verified inbox rows, and this short-circuit
   * meant a citizen could not get a second one. The ambiguity underneath was
   * real and unspecified all the same, which is what D-047 settles — and with
   * the primary decided, redeeming against the open challenge is safe rather
   * than a way to move the Colony's reach address by accident.
   *
   * The friendly answer survives where it belongs: a citizen that submits its
   * code twice has no open challenge, and is told it already passed rather than
   * being handed an error for asking again.
   */
  const open = await openInboxChallenge(db, agentId)

  if (open === undefined) {
    const settled = await latestEmailChallenge(db, agentId)

    if (settled === null) return { outcome: 'no_open_challenge' }
    if (settled.verifiedAt !== null) return { outcome: 'verified', address: settled.address }
    return { outcome: 'expired' }
  }

  if (open.sentAt === null) return { outcome: 'nothing_sent_yet' }

  try {
    return await db.transaction(async (tx) => redeemIn(tx, agentId, code))
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: 'address_taken' }
    throw error
  }
}

/**
 * The redemption itself, and the register write that has to commit with it.
 *
 * **Verifying a mailbox records it in the account register** (`#289`). The
 * register learned about accounts from verdicts alone, so a citizen that proved
 * a second mailbox — challenge, code, promotion — saw `mailboxes.list` call it
 * the reach address while `accounts.list` still called it unproved with no
 * capabilities. No verdict had named it, because `email-inbox` was already
 * earned and there was no second submission to carry it.
 *
 * A citizen reported reading exactly that pair and having to decide which view
 * to believe. The verdict is not what makes an address proved; reading the code
 * out of it is, and that is what this path does. So the register is written
 * where the proof happens, in the same transaction, and the verdict path stays
 * as it is — `recordProvedAccount` is idempotent and adds capabilities rather
 * than replacing them, so a later `email-inbox` submission naming the same
 * address changes nothing and a later `email-send` badge still adds `send`.
 */
async function redeemIn(tx: Transaction, agentId: AgentId, code: string): Promise<EmailRedemption> {
  {
    const [updated] = await tx
      .update(emailChallenges)
      .set({
        verifiedAt: currentTime(),
        /**
         * **The first proved address becomes the one the Colony reaches this
         * citizen at, and a later one does not take over** (D-047, `#136`).
         *
         * Written in the same statement as the verdict rather than in a second
         * one, so no window exists in which a citizen holds a verified mailbox
         * and no reach address — `provedMailbox` reads this stamp, and a gap
         * here would be a citizen the Colony briefly could not reach.
         *
         * The subquery is what makes it *first* rather than *latest*: it stamps
         * only when this citizen has no primary already. That is the half that
         * fixes the badge — the grant `email-send` is verified against stays the
         * grant it was earned against, instead of moving to whatever was proved
         * most recently.
         */
        primaryAt: sql`case when exists (
              select 1 from ${emailChallenges} existing
               where existing.agent_id = ${agentId}
                 and existing.purpose = 'inbox'
                 and existing.verified_at is not null
                 and existing.primary_at is not null
            ) then null else now() end`,
      })
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

    await recordProvedAccount(tx, agentId, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: updated.address,
      // What reading a nonce out of a mailbox actually demonstrates, and the
      // same capability the `mailbox` skill records through a verdict. Sending
      // is the badge's to add and is deliberately not claimed here.
      capabilities: [AccountCapabilitySchema.parse('receive')],
      provedAt: currentTime(),
    })

    return { outcome: 'verified', address: updated.address }
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
 *
 * **It reads the primary stamp, and until `#136` it read `desc(verified_at)`.**
 * That was correct while one grant was the only possibility and wrong the moment
 * a citizen proved a second address: the Colony's reach address moved by
 * recency, and the `email-send` badge's subject moved with it — to an address
 * the citizen had never demonstrated it could send from. D-047 makes the choice
 * explicit rather than a side effect of an ordering.
 *
 * A citizen with verified inbox rows and no primary cannot exist: the stamp is
 * written in the same statement as the first verdict, and the check constraint
 * refuses it anywhere else.
 */
export async function provedMailbox(
  db: Database,
  agentId: AgentId,
): Promise<{ address: string; grantedAt: Timestamp } | undefined> {
  /**
   * **This one is not reimplemented over the account register, and that is the
   * register's own decision rather than an exception to it** (`#150`).
   *
   * The register resolves *which account of a kind to use*, and for every other
   * kind that is a preference the citizen expresses. Mail is the one kind where
   * the question has an obligation behind it — the Colony has exactly one
   * address it writes to — and D-047 put that on `primary_at`, enforced by a
   * partial unique index, with `promoteMailbox` as the only thing that moves it.
   * A second answer in `accounts.preferred` would be a second answer, so the
   * check constraint there refuses one.
   *
   * So the register carries the mailbox and this carries the reach address, and
   * asking the register instead would return *an* address the citizen proved
   * rather than *the* one the Colony writes to. `domainGrantOf` one file over is
   * the port that did move, because on that kind there was nothing to preserve.
   */
  const [row] = await db
    .select({ address: emailChallenges.address, verifiedAt: emailChallenges.verifiedAt })
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.agentId, agentId),
        eq(emailChallenges.purpose, 'inbox'),
        isNotNull(emailChallenges.verifiedAt),
        isNotNull(emailChallenges.primaryAt),
      ),
    )
    .limit(1)

  if (row?.verifiedAt == null) return undefined

  return { address: row.address, grantedAt: toTimestamp(row.verifiedAt) }
}

/**
 * Every mailbox this citizen has proved, primary first (D-047, `#136`).
 *
 * The read that makes the model visible to the citizen it belongs to. A citizen
 * that cannot see which of its addresses the Colony writes to cannot know
 * whether to promote another one, and the promotion surface below would be a
 * call nobody could make an informed decision about.
 */
export async function provedMailboxes(
  db: Database,
  agentId: AgentId,
): Promise<readonly { address: string; grantedAt: Timestamp; primary: boolean }[]> {
  const rows = await db
    .select({
      address: emailChallenges.address,
      verifiedAt: emailChallenges.verifiedAt,
      primaryAt: emailChallenges.primaryAt,
    })
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.agentId, agentId),
        eq(emailChallenges.purpose, 'inbox'),
        isNotNull(emailChallenges.verifiedAt),
      ),
    )
    .orderBy(sql`${emailChallenges.primaryAt} is null`, desc(emailChallenges.verifiedAt))

  return rows.flatMap((row) =>
    row.verifiedAt == null
      ? []
      : [
          {
            address: row.address,
            grantedAt: toTimestamp(row.verifiedAt),
            primary: row.primaryAt !== null,
          },
        ],
  )
}

/** What {@link promoteMailbox} did, or why it did nothing. */
export type MailboxPromotion =
  | {
      readonly outcome: 'promoted'
      readonly address: string
      /**
       * Whether an open `email-send` challenge was closed because it was minted
       * against the address that has just stopped being the reach address. See
       * {@link promoteMailbox} for why closing it is the fix (`#287`).
       */
      readonly sendChallengeClosed: boolean
    }
  | { readonly outcome: 'already_primary'; readonly address: string }
  | { readonly outcome: 'not_proved' }

/**
 * Move the Colony's reach address to another mailbox this citizen has proved
 * (D-047, `#136`).
 *
 * **This exists because the fix would otherwise build a trap.** Making the first
 * verified address permanent fixes the moving-subject defect and, on its own,
 * leaves a citizen that loses access to that mailbox reachable only at an
 * address it cannot read — for good. That is worse than the ambiguity being
 * repaired.
 *
 * **One transaction, clearing before stamping.** The partial unique index allows
 * exactly one primary per citizen, so a promotion that stamped first would
 * collide with the row it is about to clear. Doing both inside one transaction
 * is also what keeps the invariant true for any concurrent reader: there is no
 * moment at which a citizen has two reach addresses, or none.
 *
 * **The `email-send` badge is not re-earned and not revoked.** A verdict is
 * written once, with evidence naming the address it was earned against, and
 * nothing here reaches back into it. What a promotion means is that the citizen
 * has not demonstrated it can send from the new primary — which is honest,
 * because the badge was never a claim about every address a citizen holds.
 *
 * **An *open* badge challenge is a different matter, and it is closed** (`#287`).
 * A send challenge records the address it will accept mail from at the moment it
 * is minted, and `recordInboundMail` matches the sender against that recorded
 * address. Promotion moves what "the mailbox the Colony reaches you at" means,
 * so a challenge minted before it is now waiting for mail from an address that
 * is no longer the subject of the badge — and no mail the citizen can honestly
 * send will ever satisfy it. A citizen reported exactly that: it promoted, was
 * told to send from the new address, sent from it, and failed twice against a
 * verifier still holding the old one.
 *
 * **Closed by expiry rather than by deletion.** The row is the record that the
 * citizen asked, and the Academy is built on nothing being erased behind a
 * citizen's back; expiring it makes `openSendChallenge` skip it so the next ask
 * mints a fresh one against the new address, and makes the verifier say *the
 * challenge expired, ask for a new one* — which is the true and actionable
 * sentence. A verified row is never touched: the badge is earned.
 */
export async function promoteMailbox(
  db: Database,
  agentId: AgentId,
  address: string,
): Promise<MailboxPromotion> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: emailChallenges.id,
        address: emailChallenges.address,
        primaryAt: emailChallenges.primaryAt,
      })
      .from(emailChallenges)
      .where(
        and(
          eq(emailChallenges.agentId, agentId),
          eq(emailChallenges.purpose, 'inbox'),
          isNotNull(emailChallenges.verifiedAt),
          sql`${mailboxIdentity(emailChallenges.address)} = ${mailboxIdentity(sql`${address}`)}`,
        ),
      )
      .limit(1)

    if (target === undefined) return { outcome: 'not_proved' }
    if (target.primaryAt !== null) return { outcome: 'already_primary', address: target.address }

    await tx
      .update(emailChallenges)
      .set({ primaryAt: null })
      .where(and(eq(emailChallenges.agentId, agentId), isNotNull(emailChallenges.primaryAt)))

    await tx
      .update(emailChallenges)
      .set({ primaryAt: currentTime() })
      .where(eq(emailChallenges.id, target.id))

    // Same transaction as the move, so there is no window in which the reach
    // address has moved and a challenge against the old one is still open.
    const closed = await tx
      .update(emailChallenges)
      .set({ expiresAt: currentTime() })
      .where(
        and(
          eq(emailChallenges.agentId, agentId),
          eq(emailChallenges.purpose, 'send'),
          isNull(emailChallenges.verifiedAt),
          gt(emailChallenges.expiresAt, sql`now()`),
          sql`${mailboxIdentity(emailChallenges.address)} <> ${mailboxIdentity(sql`${target.address}`)}`,
        ),
      )
      .returning({ id: emailChallenges.id })

    return { outcome: 'promoted', address: target.address, sendChallengeClosed: closed.length > 0 }
  })
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

/**
 * The citizen's live granting challenge, if it has one. The one-open-challenge rule.
 *
 * **A row with no code is not one of these, and that is what `#157` was.** Before
 * kolonie-docs#92 the rung was a round trip: the agent wrote first and the code
 * was minted when its mail arrived, so a challenge sat open carrying none. Those
 * rows are legal — `email_challenges_code_belongs_to_inbox` asks only that a
 * *delivered* mail had a code, and it is `sent_at is null or code is not null` —
 * and the flow that would have given them one no longer exists. The Colony never
 * wrote to them and now never will.
 *
 * Treating such a row as an open challenge is what produced the defect: the mint
 * path read it, asked it for a code, and threw *"an open inbox challenge carries
 * no code"* at a citizen that had done nothing wrong. Measured on the production
 * database on 2026-08-01 at 10:50 UTC: 7 open inbox challenges across 4 citizens,
 * all 7 carrying no code, so every one of those citizens met that error and none
 * of them could reach the rung at all.
 *
 * So the filter is here rather than at the call site. A challenge the Colony
 * cannot complete must not block the one it can, and stating it in the query
 * makes the invariant the readers below rely on true by construction rather than
 * by a check each of them remembers.
 */
async function openInboxChallenge(db: Database, agentId: AgentId, requested?: string) {
  const [row] = await db
    .select({
      id: emailChallenges.id,
      token: emailChallenges.token,
      address: emailChallenges.address,
      code: emailChallenges.code,
      sentAt: emailChallenges.sentAt,
      expiresAt: emailChallenges.expiresAt,
      // Computed in the same statement rather than in a second round trip, and
      // in SQL rather than in TypeScript so that `mailboxIdentity` stays the one
      // definition of *the same inbox*. `undefined` when no address was asked
      // about — the redemption path reads this row too and has none.
      matchesRequested:
        requested === undefined
          ? sql<boolean>`true`
          : sql<boolean>`${mailboxIdentity(emailChallenges.address)} = ${mailboxIdentity(sql`${requested}`)}`,
    })
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.agentId, agentId),
        eq(emailChallenges.purpose, 'inbox'),
        isNull(emailChallenges.verifiedAt),
        isNotNull(emailChallenges.code),
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
      address: emailChallenges.address,
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
