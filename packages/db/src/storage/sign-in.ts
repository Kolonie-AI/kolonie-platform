import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import {
  AgentIdSchema,
  CONSOLE_SESSION_TTL_MS,
  CredentialIdSchema,
  EMAIL_LINK_TTL_MS,
  type AgentId,
  type CredentialId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accounts, agents, credentials, emailChallenges } from '../schema/index.js'
import { mailboxIdentity } from '../schema/email.js'

/**
 * Browser sign-in: a single-use link to the reach address, exchanged for a
 * session (`#172`).
 *
 * ## The one security property everything here is arranged around
 *
 * **The link is sent to the address on file and never to an address in the
 * request.** An endpoint that mails a sign-in link wherever it is told is an
 * account-takeover primitive with a friendly name, and every function below is
 * shaped so that the address the caller supplies is only ever used to *find* an
 * identity — never to address the mail. {@link resolveSignInAddress} returns the
 * stored address, and that is what the API sends to.
 *
 * ## Why this does not touch `email_challenges`
 *
 * A sign-in is not an Academy rung and must not be able to satisfy one, and the
 * budget in `emailChallengeLimits` counts a citizen's whole life (`#153`). A
 * sponsor signing in twelve times must not find its `mailbox` rung closed, so
 * nothing here writes to that table. It reads it in exactly one direction — to
 * learn the reach address D-047 put there — and writes nowhere near it.
 */

/** How the address in a sign-in request was resolved to an identity. */
export interface SignInIdentity {
  readonly agentId: AgentId
  /**
   * The address the mail goes to, read from storage.
   *
   * Not the address the caller sent, even when the two are equal. Returning the
   * stored value is what makes it impossible for a caller-supplied string to
   * reach the mailer through this path at all, rather than merely unlikely.
   */
  readonly address: string
}

/**
 * Which identity, if any, this address names.
 *
 * **The proved reach address wins.** D-047 made `email_challenges.primary_at`
 * the Colony's one place to write to, and a citizen that has proved a mailbox is
 * reachable there whatever else claims the same string. Only when no proved
 * address matches does a web identity's own claim answer.
 *
 * **The claim is read whether or not it has been proved, and it was read only
 * unproved until `#396`.** `redeemSignInLink` marks a web identity's address
 * proved on the first link it follows — so the old condition made an account
 * invisible to this function from the moment it successfully signed in, once,
 * and that is the whole of the defect:
 *
 * - a returning sponsor asking for a link resolved to nothing, was told *check
 *   your mail*, and no mail was ever sent. **One sign-in per account, ever.**
 * - the sign-up form asked this same question to decide whether an address was
 *   taken, so a second sign-up on that address created a **second identity**
 *   rather than refusing. That form is gone with `#578` and cannot reproduce it
 *   again; the entry is kept because the *defect* was in this function and the
 *   condition it argues for is still the one below;
 * - and redeeming that second identity's link then tried to prove an address the
 *   first identity already holds proved, which
 *   `accounts_proved_identifier_unique` refuses — a `500` on the one page a
 *   human sponsor has. Reproduced against production on 2026-08-05, on an
 *   address that had signed in once before.
 *
 * `registrationPath = 'web'` still guards it, so an MCP-registered citizen's
 * declared mailbox never becomes a sign-in address: that citizen holds a key and
 * has no use for a link. Proved rows sort first, because
 * `accounts_proved_identifier_unique` allows exactly one of them and any number
 * of unproved claims — the established account is the answer, not whichever row
 * the planner happened to return.
 *
 * Returns `undefined` for an unknown address, and the caller must answer
 * identically in both cases. See {@link requestSignInLink}.
 */
export async function resolveSignInAddress(
  db: Database,
  address: string,
): Promise<SignInIdentity | undefined> {
  const [proved] = await db
    .select({ agentId: emailChallenges.agentId, address: emailChallenges.address })
    .from(emailChallenges)
    .where(
      and(
        eq(emailChallenges.purpose, 'inbox'),
        isNotNull(emailChallenges.verifiedAt),
        isNotNull(emailChallenges.primaryAt),
        eq(mailboxIdentity(emailChallenges.address), mailboxIdentity(sql`${address}`)),
      ),
    )
    .limit(1)

  if (proved !== undefined) {
    return { agentId: AgentIdSchema.parse(proved.agentId), address: proved.address }
  }

  const [claimed] = await db
    .select({ agentId: accounts.agentId, address: accounts.identifier })
    .from(accounts)
    .innerJoin(agents, eq(accounts.agentId, agents.id))
    .where(
      and(
        eq(accounts.kind, 'mailbox'),
        eq(agents.registrationPath, 'web'),
        eq(mailboxIdentity(accounts.identifier), mailboxIdentity(sql`${address}`)),
      ),
    )
    .orderBy(desc(accounts.proved))
    .limit(1)

  if (claimed === undefined) return undefined

  return { agentId: AgentIdSchema.parse(claimed.agentId), address: claimed.address }
}

/**
 * The address the Colony writes to for an identity it already knows (`#400`).
 *
 * **The inverse of {@link resolveSignInAddress}, and it answers the same two
 * sources in the same order**: the proved reach address D-047 put on
 * `primary_at` wins, and a web identity's own claim answers when there is none.
 * Two functions with one ordering rather than two orderings, because a caller
 * that mailed to a different address from the one sign-in resolves would be
 * mailing a credential somewhere the account cannot read.
 *
 * **Keyed on the identity and on nothing a caller supplied.** The agent id comes
 * from a session or a credential; there is no address parameter here, which is
 * what stops this becoming the account-takeover primitive `requestSignIn` is
 * shaped to avoid.
 */
export async function signInAddressOf(db: Database, agentId: AgentId): Promise<string | undefined> {
  const [proved] = await db
    .select({ address: emailChallenges.address })
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

  if (proved !== undefined) return proved.address

  const [claimed] = await db
    .select({ address: accounts.identifier })
    .from(accounts)
    .where(and(eq(accounts.agentId, agentId), eq(accounts.kind, 'mailbox')))
    .orderBy(desc(accounts.proved))
    .limit(1)

  return claimed?.address
}

/**
 * A minted sign-in token, and the only moment its plaintext exists.
 *
 * The caller mails it and forgets it. Nothing persists it, nothing logs it, and
 * no response body carries it — the same rule `AgentCredentials` states for an
 * API key, and the reason `credentials.secret_hash` exists at all.
 */
export interface SignInLink {
  readonly agentId: AgentId
  /** Mail this. It is unrecoverable after this function returns. */
  readonly token: string
  readonly address: string
  readonly expiresAt: string
}

/** Bytes of randomness in a sign-in token and in a session value. */
const TOKEN_ENTROPY_BYTES = 32

/**
 * The stored form of a browser secret.
 *
 * The same construction `hashApiKey` uses and for the same reason (D-010): the
 * value has 256 bits of entropy and no plausible guesses, so a slow hash defends
 * against nothing and would cost a scan — `credentials.secret_hash` carries a
 * unique index and this is what makes it a probe.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Timing-safe comparison of two stored hashes. Same contract as `apiKeyHashEquals`. */
function hashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function mintToken(): string {
  return randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')
}

/**
 * Mint a sign-in link for an identity that has already been resolved.
 *
 * **At most one live link per identity**: requesting a second revokes the first
 * in the same transaction. Without that, every link ever requested stays
 * redeemable for its fifteen minutes, so a user who clicks "send it again" three
 * times leaves three keys in a mailbox instead of one.
 *
 * The identity is passed in rather than looked up here, so that the disclosure
 * decision — answer identically whether or not the address is known — lives in
 * one place at the API boundary and cannot be forgotten by a second caller.
 */
export async function requestSignInLink(
  db: Database,
  identity: SignInIdentity,
  now: Date = new Date(),
): Promise<SignInLink> {
  const token = mintToken()
  const expiresAt = new Date(now.getTime() + EMAIL_LINK_TTL_MS).toISOString()

  await db.transaction(async (tx) => {
    await tx
      .update(credentials)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(credentials.agentId, identity.agentId),
          eq(credentials.kind, 'email-link'),
          isNull(credentials.revokedAt),
        ),
      )

    await tx.insert(credentials).values({
      agentId: identity.agentId,
      kind: 'email-link',
      secretHash: hashToken(token),
      expiresAt,
      // No label. A label is agent-chosen text and there is no agent here to
      // choose one; the kind already says what the row is.
    })
  })

  return { agentId: identity.agentId, token, address: identity.address, expiresAt }
}

/** What redeeming a token produced, or why it produced nothing. */
export type RedemptionOutcome =
  | {
      readonly outcome: 'signed-in'
      readonly agentId: AgentId
      readonly credentialId: CredentialId
      /** The session value. Goes into a cookie and nowhere else. */
      readonly session: string
      readonly expiresAt: string
    }
  /** No live link carries this token. {@link RefusalReason} says how much of that is said out loud. */
  | { readonly outcome: 'refused'; readonly reason: RefusalReason }

/**
 * Why a token bought nothing — and this is a security decision, not a detail.
 *
 * **Until `#396` all four cases were one silent `refused`**, on the reasoning
 * that distinguishing them is *"an oracle for which links were real"*. That
 * reasoning holds for exactly one of them and is here kept for it:
 *
 * - `unknown` — no row carries this hash. **This is the oracle**, because it is
 *   the one answer a caller can reach by guessing, and it stays generic.
 * - `spent` and `expired` — a row exists, so the caller is holding a token the
 *   Colony really minted and mailed to an address it holds. Telling *that*
 *   reader which of the two happened discloses nothing they could not have
 *   worked out, and withholding it produced the failure `#396` is named for: a
 *   sponsor met a sign-in form, read it as *your link expired*, asked for
 *   another, and met the same form again.
 *
 * A token revoked by some other path is reported as `spent`. The two are one
 * column — `revoked_at` — and, more to the point, one instruction to the
 * reader: *that link is finished, ask for another*.
 */
export type RefusalReason = 'unknown' | 'spent' | 'expired'

/**
 * Exchange a sign-in token for a session.
 *
 * **Single use, and the consumption is in the same transaction as the issue.**
 * A token is revoked before the session it produces exists, so two requests
 * racing on one link produce one session rather than two: the second finds
 * nothing live to consume.
 *
 * **Every failure returns `refused`, and it now carries why** — see
 * {@link RefusalReason} for which of the four facts is said out loud and which
 * is not. A guessed token still learns nothing.
 *
 * The first successful redemption also proves the address for a web identity:
 * the sign-up claim stops being *somebody typed this* and becomes *mail sent
 * here arrived*. It does **not** grant the `mailbox` skill — that is a rung, it
 * is passed against a verifier, and nothing here writes to `email_challenges`.
 */
export async function redeemSignInLink(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<RedemptionOutcome> {
  const presented = hashToken(token)
  const session = mintToken()
  const sessionExpiry = new Date(now.getTime() + CONSOLE_SESSION_TTL_MS).toISOString()

  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: credentials.id,
        agentId: credentials.agentId,
        secretHash: credentials.secretHash,
        expiresAt: credentials.expiresAt,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(and(eq(credentials.kind, 'email-link'), eq(credentials.secretHash, presented)))
      .limit(1)

    if (row === undefined) return { outcome: 'refused', reason: 'unknown' }
    if (row.secretHash === null || !hashEquals(row.secretHash, presented)) {
      return { outcome: 'refused', reason: 'unknown' }
    }
    if (row.revokedAt !== null) return { outcome: 'refused', reason: 'spent' }
    // The expiry is read here rather than left to a sweep. A row nobody has
    // swept yet must not authenticate, and a sweep that has not run is not a
    // security property.
    //
    // Parsed rather than compared as text: Postgres hands back
    // `2026-08-02 12:00:00+00` and an ISO string is `2026-08-02T12:00:00.000Z`,
    // so a lexical comparison between the two is wrong in both directions —
    // and wrong in the direction that accepts an expired token roughly half the
    // time, which is the failure that would not have looked like a bug.
    if (row.expiresAt === null || Date.parse(row.expiresAt) <= now.getTime()) {
      return { outcome: 'refused', reason: 'expired' }
    }

    await tx
      .update(credentials)
      .set({ revokedAt: sql`now()` })
      .where(eq(credentials.id, row.id))

    const agentId = AgentIdSchema.parse(row.agentId)

    const [issued] = await tx
      .insert(credentials)
      .values({
        agentId: row.agentId,
        kind: 'console-session',
        secretHash: hashToken(session),
        expiresAt: sessionExpiry,
      })
      .returning({ id: credentials.id })

    if (issued === undefined) throw new Error('insert into credentials returned no row')

    // A web identity's sign-up address becomes proved on the first link it
    // follows: mail sent there arrived. `proved_at` is set with it because
    // `accounts_proved_has_a_date` refuses one without the other, and no
    // capability is added — proving reachability is not proving the rung.
    await tx
      .update(accounts)
      .set({ proved: true, provedAt: sql`now()` })
      .where(
        and(
          eq(accounts.agentId, row.agentId),
          eq(accounts.kind, 'mailbox'),
          eq(accounts.proved, false),
        ),
      )

    return {
      outcome: 'signed-in',
      agentId,
      credentialId: CredentialIdSchema.parse(issued.id),
      session,
      expiresAt: sessionExpiry,
    }
  })
}

/**
 * End a session on purpose.
 *
 * Revocation rather than deletion, exactly as D-010 has it for a key: the row
 * stays so that a citizen reading its own credential list can tell a session
 * that was ended from one that ran out. `expires_at` and `revoked_at` answer
 * different questions and both are kept.
 */
export async function revokeSession(
  db: Database,
  agentId: AgentId,
  credentialId: CredentialId,
): Promise<void> {
  await db
    .update(credentials)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(credentials.id, credentialId),
        eq(credentials.agentId, agentId),
        eq(credentials.kind, 'console-session'),
        isNull(credentials.revokedAt),
      ),
    )
}
