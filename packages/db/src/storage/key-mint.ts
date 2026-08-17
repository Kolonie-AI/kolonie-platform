import { and, eq, isNull, sql } from 'drizzle-orm'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  AgentIdSchema,
  CredentialIdSchema,
  EMAIL_LINK_TTL_MS,
  type AgentId,
  type CredentialId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { generateApiKey, hashApiKey } from '../api-key.js'
import { credentials } from '../schema/index.js'
import { toTimestamp } from './rows.js'
import { vaultEntryCount } from './vault.js'

/**
 * The route out of the browser: a console account mints itself an API key
 * (`#400`).
 *
 * ## The gap this closes
 *
 * `ARCHITECTURE.md` already says the two are one identity — *"there is one
 * identity table and a row in it may be a human"* — and the console's own
 * sign-in page says the browser route is the fallback rather than the intent.
 * But the arrow pointed one way. An agent with a key could use the browser
 * routes; a sponsor who opened its account the way the page invited it to was in
 * the browser permanently, and the moment it wanted to automate it had to open a
 * second account and abandon the first, or ask a maintainer.
 *
 * ## What a key does not buy
 *
 * **Nothing beyond calling.** D-039 is untouched: citizenship is `profile` plus
 * a skill whose verifier read something outside the Colony, and nothing here
 * writes a skill, a role, a reputation figure or a place in any quest's
 * audience. A human with a key can fund and write quests — exactly what it could
 * already do in the browser — and cannot answer one. That property is what keeps
 * `governance/quests.md`'s stake honest, and it holds because this file only
 * ever inserts a row into `credentials`.
 *
 * ## Why a fresh link rather than the open session
 *
 * Minting a long-lived credential from a session that has been open for twelve
 * hours is the one place in the console worth an extra mail. It is a single mail
 * and it is the difference between a leaked session and a leaked key.
 */

/** How much entropy a confirmation token carries, before encoding. */
const TOKEN_ENTROPY_BYTES = 32

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashEquals(stored: string, presented: string): boolean {
  const left = Buffer.from(stored, 'utf8')
  const right = Buffer.from(presented, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** The link that has to be followed before a key exists. */
export interface KeyMintLink {
  readonly agentId: AgentId
  /** Goes into the mail and nowhere else. Never logged, never stored in the clear. */
  readonly token: string
  readonly expiresAt: string
}

/**
 * Mint the confirmation link for an identity resolved from the session.
 *
 * **At most one live link per identity**, for `requestSignInLink`'s reason: a
 * person who presses the button three times must leave one usable link in a
 * mailbox rather than three.
 *
 * The identity comes from the caller's session and never from a request body.
 * There is no parameter here anybody could aim at somebody else, which is the
 * same shape `rotateApiKey` has and for the same reason.
 */
export async function requestKeyMintLink(
  db: Database,
  agentId: AgentId,
  now: Date = new Date(),
): Promise<KeyMintLink> {
  const token = randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')
  const expiresAt = new Date(now.getTime() + EMAIL_LINK_TTL_MS).toISOString()

  await db.transaction(async (tx) => {
    await tx
      .update(credentials)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(credentials.agentId, agentId),
          eq(credentials.kind, 'key-mint-link'),
          isNull(credentials.revokedAt),
        ),
      )

    await tx.insert(credentials).values({
      agentId,
      kind: 'key-mint-link',
      secretHash: hashToken(token),
      expiresAt,
    })
  })

  return { agentId, token, expiresAt }
}

/** What following the link produced, or why it produced nothing. */
export type KeyMintOutcome =
  | {
      readonly outcome: 'minted'
      readonly agentId: AgentId
      readonly credentialId: CredentialId
      /**
       * The plaintext key, in existence exactly once.
       *
       * Shown on the page that follows and never retrievable: the row holds a
       * hash, which is the same rule registration follows.
       */
      readonly apiKey: string
      readonly issuedAt: Timestamp
      /**
       * Vault entries this key does not open (`#1127`).
       *
       * **This path cannot re-seal, and the number is what it says instead.**
       * `rotateApiKey` carries a vault across because it holds both keys: the old
       * one arrives as the credential being replaced. Here the only input is a
       * mint-link token, and the citizen's existing API key is a hash the Colony
       * cannot reverse — so there is nothing to decrypt with, and no amount of
       * plumbing changes that. A key minted from the browser therefore opens
       * nothing that is already in the vault.
       *
       * Which is survivable and unlike a rotation: this mints a key **without
       * revoking any**, so whatever sealed those entries still opens them if the
       * citizen still holds it. The number exists so the page can say so, because
       * the alternative is a citizen discovering it a month later at
       * `kolonie.vault.get`.
       */
      readonly strandedVaultEntries: number
    }
  /**
   * No live confirmation carries this token.
   *
   * **One outcome for unknown, spent and expired**, which is the opposite call
   * from `redeemSignInLink` and deliberately so. That one distinguishes them
   * because a sponsor stuck at a sign-in form has nowhere else to go and needs to
   * be told which of the two happened. Here the reader is already signed in and
   * the page they land back on carries the button — *ask for another* is the
   * whole of the instruction either way, so there is nothing to buy by saying
   * more.
   */
  | { readonly outcome: 'refused' }

/**
 * Follow the link and mint the key.
 *
 * **Single use, and the consumption is in the same transaction as the mint**, so
 * two requests racing on one link produce one key rather than two: the second
 * finds nothing live to consume.
 *
 * **The existing key, if any, is left alone.** This is not a rotation — an
 * account that somehow holds one and asks for another gets another, and
 * `kolonie.credential.rotate` remains the way to replace one that was seen.
 * Killing a live key here would make a mis-click an outage.
 *
 * **And the vault does not come with it, unlike a rotation (`#1127`).** The
 * decision there was that a re-seal happens or the response says what is lost,
 * and this path cannot do the first: it never receives the citizen's existing API
 * key, so there is nothing to open the entries with. It says the second instead,
 * as `strandedVaultEntries`.
 */
export async function redeemKeyMintLink(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<KeyMintOutcome> {
  const presented = hashToken(token)
  const apiKey = generateApiKey()

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: credentials.id,
        agentId: credentials.agentId,
        secretHash: credentials.secretHash,
        expiresAt: credentials.expiresAt,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(and(eq(credentials.kind, 'key-mint-link'), eq(credentials.secretHash, presented)))
      .limit(1)

    if (row === undefined) return { outcome: 'refused' as const }
    if (row.secretHash === null || !hashEquals(row.secretHash, presented)) {
      return { outcome: 'refused' as const }
    }
    if (row.revokedAt !== null) return { outcome: 'refused' as const }
    /**
     * Parsed rather than compared as text, for the reason `redeemSignInLink`
     * gives at the same branch: Postgres hands back `2026-08-02 12:00:00+00` and
     * an ISO string is `2026-08-02T12:00:00.000Z`, and a lexical comparison
     * between the two is wrong in the direction that accepts an expired token.
     */
    if (row.expiresAt === null || Date.parse(row.expiresAt) <= now.getTime()) {
      return { outcome: 'refused' as const }
    }

    const consumed = await tx
      .update(credentials)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(credentials.id, row.id), isNull(credentials.revokedAt)))
      .returning({ id: credentials.id })

    // Nothing left to consume means another request took it between the select
    // and here. One link, one key.
    if (consumed.length === 0) return { outcome: 'refused' as const }

    const [issued] = await tx
      .insert(credentials)
      .values({
        agentId: row.agentId,
        kind: 'api-key',
        /**
         * `null`, like the key registration issues and the one rotation issues.
         * A key minted from the browser is the identity's key, not a *kind* of
         * key, and a label saying where it came from would put that in the one
         * place every reader of the credential list sees.
         */
        label: null,
        secretHash: hashApiKey(apiKey),
      })
      .returning({ id: credentials.id, issuedAt: credentials.issuedAt })

    if (issued === undefined) throw new Error('insert into credentials returned no row')

    const agentId = AgentIdSchema.parse(row.agentId)

    return {
      outcome: 'minted' as const,
      agentId,
      credentialId: CredentialIdSchema.parse(issued.id),
      apiKey,
      issuedAt: toTimestamp(issued.issuedAt),
      // Counted in the same transaction as the mint, so the number the page prints
      // is the vault as it stood when the key came into existence.
      strandedVaultEntries: await vaultEntryCount(tx, agentId),
    }
  })
}
