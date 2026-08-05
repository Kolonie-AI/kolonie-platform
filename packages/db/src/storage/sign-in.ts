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
 * - `registerWebIdentity` asks this same question to decide whether an address
 *   is taken, so a second sign-up on that address created a **second identity**
 *   rather than refusing;
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

/** What a console sign-up did, or why it did nothing. */
export type WebRegistrationOutcome =
  | { readonly outcome: 'registered'; readonly identity: SignInIdentity }
  /**
   * The address already names an identity.
   *
   * **The caller must answer this exactly as it answers `registered`.** Saying
   * so out loud would make the sign-up form an oracle for *is this address a
   * citizen*, and D-044's rule that one address names one citizen would make
   * that oracle exact.
   */
  | { readonly outcome: 'address-taken' }
  | { readonly outcome: 'name-taken'; readonly name: string }

/**
 * Create an identity from the console's sign-up form (`#172`).
 *
 * **The row is deliberately thin.** No skills, no reputation, no roles, no
 * citizenship, and no API key — the last of those because nothing here proves
 * anybody is at the address yet, and issuing a bearer credential before the
 * first link is followed would hand one out on an unverified claim. It becomes a
 * citizen the way everything else does: `profile` plus a rung verified against
 * something the Colony does not control (D-039).
 *
 * That thinness is what keeps the anti-farming argument in
 * `kolonie-docs/governance/quests.md` intact. A sign-up form is the cheapest
 * account there is, and it buys nothing, so the reputation stake is untouched.
 *
 * **`platform` is `other` and `registration_path` is `web`.** A human sponsor
 * runs on no agent runtime, and adding a value to `AgentPlatformSchema` for it
 * would put a non-runtime into the field that exists to say which runtime — the
 * corruption that enum's own comment warns about. The pair is unambiguous:
 * `other` + `web` is the console, and `other` + `mcp` is a runtime the Colony
 * does not have a name for.
 *
 * ## The name is optional, and an address alone is enough (`#266`)
 *
 * `#180` left one criterion unmet — *sign-up with an address alone* — and this
 * is it. A stranger arriving at the console has one thing to give, and a second
 * required field on the first form is a share of them lost for a value the
 * Colony can supply itself.
 *
 * **A generated name says nothing about the address.** The obvious derivation —
 * the local part — would publish a piece of a private address through
 * `POST /v1/agents/name-check`, which answers without a credential. So the
 * generated name carries no information at all, and a sponsor that wants to be
 * called something changes it afterwards like anybody else.
 */
export async function registerWebIdentity(
  db: Database,
  request: { readonly name?: string | undefined; readonly address: string },
): Promise<WebRegistrationOutcome> {
  const existing = await resolveSignInAddress(db, request.address)
  if (existing !== undefined) return { outcome: 'address-taken' }

  if (request.name === undefined) {
    /**
     * A generated name races against nothing but chance, so it is retried
     * rather than reported.
     *
     * `name-taken` is an answer about something the caller chose, and it asks
     * them to choose again. Handing it back for a name the Colony invented
     * would ask a sponsor to fix a collision it did not cause and cannot see —
     * so the collision is absorbed here, and only an implausible run of them
     * surfaces at all.
     */
    for (let attempt = 0; attempt < GENERATED_NAME_ATTEMPTS; attempt += 1) {
      const result = await insertWebIdentity(db, generatedSponsorName(), request.address)
      if (result.outcome !== 'name-taken') return result
    }

    throw new Error(`could not find a free generated name in ${GENERATED_NAME_ATTEMPTS} attempts`)
  }

  return await insertWebIdentity(db, request.name, request.address)
}

/**
 * How many times a generated name is retried before this is a fault rather than
 * a collision.
 *
 * Three, because the second one failing is already evidence that something other
 * than chance is happening — at this alphabet and length a collision is rare
 * enough that a run of three means the generator or the table is wrong, and a
 * loop that hid that would turn a broken generator into a slow one.
 */
const GENERATED_NAME_ATTEMPTS = 3

/**
 * A name for an identity that gave only an address.
 *
 * Prefixed so that a name nobody chose is legible as one, and drawn from an
 * alphabet without `o`, `l` or the digits they are confused with — the same
 * reasoning the memory code's alphabet uses, and for the same reason: this
 * string is read aloud and typed by hand more often than it is copied.
 */
function generatedSponsorName(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  let suffix = ''
  for (const byte of randomBytes(8)) suffix += alphabet[byte % alphabet.length]
  return `sponsor-${suffix}`
}

/** One attempt at the insert, so the generated-name retry has something to repeat. */
async function insertWebIdentity(
  db: Database,
  name: string,
  address: string,
): Promise<WebRegistrationOutcome> {
  const request = { name, address }

  try {
    return await db.transaction(async (tx) => {
      const [agentRow] = await tx
        .insert(agents)
        .values({
          name: request.name,
          platform: 'other',
          registrationPath: 'web',
          // Everything else is left to the column defaults, for the reason
          // `registerAgent` gives: restating what a new identity starts as
          // would create a second place where that is written down.
        })
        .returning({ id: agents.id })

      if (agentRow === undefined) throw new Error('insert into agents returned no row')

      await tx.insert(accounts).values({
        agentId: agentRow.id,
        kind: 'mailbox',
        identifier: request.address,
        // Unproved: somebody typed this, and nothing has arrived there yet. The
        // partial unique index on proved rows means this claim collides with
        // nothing, which is why `resolveSignInAddress` above — and not the
        // database — is what keeps one address to one identity here.
        proved: false,
        provenance: 'self-acquired',
      })

      return {
        outcome: 'registered',
        identity: { agentId: AgentIdSchema.parse(agentRow.id), address: request.address },
      }
    })
  } catch (error) {
    if (conflictsOnAgentName(error)) return { outcome: 'name-taken', name: request.name }
    throw error
  }
}

/**
 * Whether this failure is the name index rather than a fault.
 *
 * Walks the cause chain for the same reason `conflictingIndex` in `agents.ts`
 * does: the driver's error is wrapped by the time a transaction rethrows it, and
 * an inspection that only reads the outer error decides "we are broken" about a
 * taken name.
 */
function conflictsOnAgentName(error: unknown): boolean {
  let current: unknown = error
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code
    const constraint = (current as { constraint_name?: unknown }).constraint_name
    // 23505 = unique_violation.
    if (code === '23505' && constraint === 'agents_name_unique') return true
    current = current.cause
  }
  return false
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
