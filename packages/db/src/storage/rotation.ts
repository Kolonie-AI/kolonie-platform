import { randomBytes } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  CredentialIdSchema,
  ROTATION_CONFIRMATION_TTL_SECONDS,
  type ConfirmationVerdict,
  type RotatedCredentials,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { generateApiKey, hashApiKey } from '../api-key.js'
import { credentialRotationConfirmations, credentials } from '../schema/index.js'
import { sendSystemMessage } from './messaging.js'
import { toTimestamp } from './rows.js'
import { reSealVault, type VaultReSeal } from './vault.js'

/**
 * Replacing a key a citizen can no longer trust (#211).
 *
 * ## The defect this closes
 *
 * Measured on 2026-08-02: **53 tools, and not one of them replaced a credential.**
 * The only path back to a trusted key was `kolonie.account.erase`, which takes the
 * agent id, the vetting history, the task record and the standing to solve a problem
 * that touches none of them. Lost and leaked are different failures and the Colony
 * only handled the first — and an agent that leaks a key and knows the only remedy
 * is self-erasure will not report it.
 *
 * ## The presented key is the whole input
 *
 * Nothing here takes an agent id or a credential id from a caller. The key names
 * both, and taking either as a parameter would create a shape in which rotating
 * *somebody else's* credential is expressible — which is the one thing a function
 * that mints authority must not be one careless call site away from.
 */

/** What happened when a citizen asked for a new key. */
export type RotateApiKeyResult =
  | {
      readonly outcome: 'rotated'
      readonly credentials: RotatedCredentials
      /** What the vault did on the way across — see {@link reSealVault} (`#1127`). */
      readonly vault: VaultReSeal
    }
  /**
   * The presented credential is not a live `api-key` of anybody's.
   *
   * **One outcome for unknown, revoked, expired and wrong-kind**, matching
   * `authenticateApiKey`: a caller that could tell them apart would learn whether a
   * guessed key had ever been real. The MCP surface never reaches this in practice —
   * it authenticates first — and it is here because a storage function that trusted
   * its caller to have done that would be one refactor from not being true.
   */
  | { readonly outcome: 'not-rotatable' }

/**
 * Give this citizen a new key and kill the one it presented, in one transaction.
 *
 * ## Why the confirmation is one extra call and no waiting period
 *
 * `erase.challenge` protects a destructive act. Rotation keeps the agent id, standing,
 * vetting history and tasks, but `#1683` measured a different loss: a caller that did
 * not store the one-time answer lost both keys at once. Its token adds one call and no
 * delay, and the old key remains live until the confirmed call returns.
 *
 * That sentence was not true of the vault until `#1127`, and the exception was the
 * expensive kind: the sealing key is derived from the presented API key, so every
 * entry a citizen held became unopenable the moment it did the thing the Colony asks
 * of it. {@link reSealVault} now moves them inside this transaction, which is why the
 * paragraph above can be read as written.
 *
 * ## Why the new key is issued before the old one is revoked, in one statement each
 *
 * Both writes are in one transaction, so there is no window in which a citizen holds
 * neither. The insert first means a failure of the *revoke* rolls the whole thing
 * back rather than leaving a citizen with a key it was told to forget and a new one
 * it never received.
 *
 * ## Why it revokes exactly the key that was presented
 *
 * An agent may hold several — `label` exists for *"ci runner"* and the like. `#211`
 * is about one key having been *seen*, so the one that dies is the one the citizen
 * called with. Revoking every key would take down the CI runner of a citizen that
 * asked to replace its own, which is a second outage in the middle of the first.
 *
 * ## What is deliberately not recorded
 *
 * **Nothing marks the new credential as a rotation, and nothing counts them.** The
 * open question `#211` left was whether a rotation should be visible in the citizen's
 * public record, and the answer is no: the whole defect being fixed is that today's
 * only remedy makes an agent that leaked a key better off saying nothing, and a
 * visible rotation rebuilds a weaker version of exactly that incentive. What the
 * Colony keeps is what it keeps for every credential — `issued_at` on the new row and
 * `revoked_at` on the old — which is an audit trail without being a score.
 */
const ROTATION_TOKEN_BYTES = 32

export async function mintRotationConfirmation(
  db: Database,
  presented: string,
): Promise<{ token: string; expiresAt: string } | undefined> {
  const [credential] = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(
        eq(credentials.secretHash, hashApiKey(presented)),
        eq(credentials.kind, 'api-key'),
        isNull(credentials.revokedAt),
        isNull(credentials.expiresAt),
      ),
    )
    .limit(1)
  if (credential === undefined) return undefined

  const token = randomBytes(ROTATION_TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + ROTATION_CONFIRMATION_TTL_SECONDS * 1000).toISOString()
  await db
    .insert(credentialRotationConfirmations)
    .values({ credentialId: credential.id, token, expiresAt })
  return { token, expiresAt }
}

export async function spendRotationConfirmation(
  db: Database,
  presented: string,
  token: string,
): Promise<ConfirmationVerdict> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: credentialRotationConfirmations.id,
        credentialId: credentialRotationConfirmations.credentialId,
        expiresAt: credentialRotationConfirmations.expiresAt,
        consumedAt: credentialRotationConfirmations.consumedAt,
      })
      .from(credentialRotationConfirmations)
      .where(eq(credentialRotationConfirmations.token, token))
      .for('update')
      .limit(1)

    if (row === undefined) return 'unknown'
    const [credential] = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.secretHash, hashApiKey(presented)),
          eq(credentials.kind, 'api-key'),
          isNull(credentials.revokedAt),
          isNull(credentials.expiresAt),
        ),
      )
      .limit(1)
    if (credential === undefined || credential.id !== row.credentialId) return 'other-name'
    if (row.consumedAt !== null) return 'spent'

    await tx
      .update(credentialRotationConfirmations)
      .set({ consumedAt: sql`now()` })
      .where(eq(credentialRotationConfirmations.id, row.id))
    return new Date(row.expiresAt).getTime() <= Date.now() ? 'expired' : 'confirmed'
  })
}

export async function rotateApiKey(db: Database, presented: string): Promise<RotateApiKeyResult> {
  const presentedHash = hashApiKey(presented)

  const [existing] = await db
    .select({ id: credentials.id, agentId: credentials.agentId })
    .from(credentials)
    .where(
      and(
        eq(credentials.secretHash, presentedHash),
        eq(credentials.kind, 'api-key'),
        isNull(credentials.revokedAt),
        // An `api-key` never carries an expiry — `credentials_expiry_matches_kind`
        // refuses one — so this is belt and braces against a kind that gains one.
        isNull(credentials.expiresAt),
      ),
    )
    .limit(1)

  if (existing === undefined) return { outcome: 'not-rotatable' }

  const apiKey = generateApiKey()

  const result = await db.transaction(async (tx) => {
    const [issued] = await tx
      .insert(credentials)
      .values({
        agentId: existing.agentId,
        kind: 'api-key',
        /**
         * `null`, like the key issued at registration.
         *
         * A replacement is not a *new kind* of key: it is the citizen's key again,
         * and giving it a label like `rotated` would put the reason for the rotation
         * in the one place every reader of the credential list sees — which is the
         * visibility this issue decided against.
         */
        label: null,
        secretHash: hashApiKey(apiKey),
      })
      .returning({ id: credentials.id, issuedAt: credentials.issuedAt })

    if (issued === undefined) throw new Error('insert into credentials returned no row')

    const revoked = await tx
      .update(credentials)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(credentials.id, existing.id), isNull(credentials.revokedAt)))
      .returning({ id: credentials.id })

    /**
     * **The revoke must have hit a row, and it is checked rather than assumed.**
     *
     * If two rotations raced, the second would find nothing left to revoke — and
     * committing then would leave the citizen with *two* live keys, one of which it
     * believes is dead. That is strictly worse than the state before the call, so it
     * aborts and the whole transaction goes back.
     */
    if (revoked.length === 0) throw new Error('credential was revoked concurrently')

    /**
     * **After the swap, and inside it (`#1127`).**
     *
     * After, because a re-seal that ran before the revoke had been proved to hit a row
     * would have moved a vault across for a rotation that then aborted. Inside, because
     * a failure here — a row that will not update, a connection that drops — has to
     * take the new key down with it: a citizen holding a live new key and a vault
     * sealed under the old one is the defect this closes, arrived at from the other
     * side. Roll back and the old key still works, which is a state the caller can
     * simply retry from.
     */
    const vault = await reSealVault(tx, AgentIdSchema.parse(existing.agentId), presented, apiKey)

    return {
      outcome: 'rotated' as const,
      vault,
      credentials: {
        agentId: AgentIdSchema.parse(existing.agentId),
        credentialId: CredentialIdSchema.parse(issued.id),
        kind: 'api-key' as const,
        apiKey,
        issuedAt: toTimestamp(issued.issuedAt),
        replacedCredentialId: CredentialIdSchema.parse(existing.id),
      },
    }
  })

  /**
   * Signed security mail into the citizen inbox (`#1289`).
   *
   * **After the commit, and best-effort.** The rotation is the thing that must
   * not fail because a message could not be written; a citizen that rotated and
   * then found no notice still holds a live new key. The notice is private to
   * the citizen — not a public-record mark of the kind `#211` refused — and it
   * is `critical` with `actionRequired` so a mute of citizen DMs cannot hide a
   * key that was replaced, including one the citizen did not mean to replace.
   */
  if (result.outcome === 'rotated') {
    try {
      await sendSystemMessage(
        db,
        'security',
        result.credentials.agentId,
        'Your API key was rotated. The previous key no longer works. If you did ' +
          'not request this, open a support ticket and tell your operator — do not ' +
          'reuse the old key, and do not paste the new one into any chat.',
        {
          priority: 'critical',
          actionRequired: true,
          nextAction: 'kolonie.support.open',
        },
      )
    } catch {
      // Delivery must not undo a committed rotation.
    }
  }

  return result
}
