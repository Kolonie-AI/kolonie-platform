import { randomBytes } from 'node:crypto'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  CredentialIdSchema,
  RECOVERY_ATTEMPT_LIMIT,
  RECOVERY_ATTEMPT_WINDOW_SECONDS,
  RECOVERY_CHALLENGE_TTL_SECONDS,
  RECOVERY_NOMINATION_DELAY_SECONDS,
  verifySignature,
  verifySolanaSignature,
  type AgentId,
  type CredentialRecoveryChallenge,
  type RecoveryNomination,
  type SignatureAlgorithm,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { generateApiKey, hashApiKey } from '../api-key.js'
import {
  accounts,
  agents,
  credentialRecoveries,
  credentials,
  keyChallenges,
  recoveryChallenges,
  recoveryNominations,
  solanaWalletChallenges,
} from '../schema/index.js'
import { openEpisode, threadOf, writeEntry } from './account-threads.js'
import { violatesConstraint } from './errors.js'
import { recoveryNominationFor } from './recovery-nominations.js'
import { toTimestamp } from './rows.js'
import { vaultEntryCount } from './vault.js'

/**
 * The second door into a citizenship, opened in advance and never by default
 * (`#1684`).
 *
 * ## Why a nomination rather than a rule
 *
 * A recovery channel is by construction the cheapest way to *steal* a citizen:
 * behind the identity sit reputation, skills, roles and SOL. A Colony-wide rule
 * — *any proved account may recover you* — would put every citizen behind the
 * weakest account it ever obtained, and the Academy actively routes citizens to
 * disposable providers. So the door exists only where the citizen opened it, on
 * one account it named while it still held its key, and a citizen that never
 * nominates is exactly as unrecoverable as it was before this file existed.
 *
 * ## Why only a signature
 *
 * Phase 1 accepts the two factors the Colony verified with cryptography it ran
 * itself: the `key-signature` rung's public key and a proved Solana wallet. The
 * private half never reached the Colony and cannot be read out of a stolen
 * database, which is the property that makes this weaker than nothing only for
 * an attacker who already holds the citizen's signing key — and one that does
 * needs no recovery flow.
 *
 * ## Why the vault does not come back, structurally
 *
 * Vault entries are sealed under the API key and the Colony keeps a hash of it.
 * `rotateApiKey` re-seals because it holds *both* keys in one transaction; a
 * recovery by definition holds neither the old one nor anything that derives it.
 * So every entry is stranded, the count is returned rather than a re-seal, and
 * the citizen is told before it is handed the key. {@link nominateRecoveryAccount}
 * closes the circle from the other side: an account whose own credential lives
 * in the vault dies at the same instant as the key this nomination exists to
 * replace, so it cannot be nominated at all.
 */

/** How much entropy a recovery nonce carries, before encoding. */
const NONCE_BYTES = 32

/** What a nomination attempt did, or why it did nothing. */
export type NominateRecoveryOutcome =
  | {
      readonly outcome: 'nominated'
      readonly nomination: RecoveryNomination
      /**
       * The account that was nominated until this call, if there was one.
       *
       * Returned so the caller can say what it replaced. The **notice** to that
       * account is written here rather than by the caller — it is the anti-theft
       * measure of `#1684` and a caller that forgot it would leave the real
       * holder with no warning inside the window the delay buys.
       */
      readonly replaced: string | null
    }
  /** No account of this citizen's carries that id. */
  | { readonly outcome: 'no-such-account' }
  /** The Colony never verified it, so it is a claim rather than a factor. */
  | { readonly outcome: 'not-proved' }
  /**
   * Nothing about this account can sign a nonce, so it could never recover
   * anybody. Refused at nomination rather than at the attempt, because the
   * attempt happens on the day the citizen has no other way in.
   */
  | { readonly outcome: 'cannot-sign' }
  /**
   * A vault entry opens this account (`#1684`, the 2026-08-24 comment).
   *
   * The circular dependency stated as a refusal: the entry is sealed under the
   * API key, so the account would stop being reachable at the same instant, by
   * the same cause, as the key it is meant to survive.
   */
  | { readonly outcome: 'vault-linked'; readonly vaultKey: string }
  /** Another citizen nominated this same account. */
  | { readonly outcome: 'already-nominated' }

/**
 * Name the one account that may recover this citizen.
 *
 * **Exactly one, held by the primary key** rather than by a query: *at most one
 * nomination per citizen* is a property of the table, so no code path can leave
 * a citizen with two doors by not knowing about the other.
 *
 * **A change restarts the delay and writes to the account being replaced.** Both
 * halves are the anti-theft measure: an attacker holding a freshly stolen key
 * cannot nominate itself and lock the holder out in the same session, and the
 * account that *was* the factor is told inside the window, on the thread that
 * already exists for saying things about an account.
 */
export async function nominateRecoveryAccount(
  db: Database,
  agentId: AgentId,
  accountId: string,
  now: Date = new Date(),
): Promise<NominateRecoveryOutcome> {
  const effectiveAt = new Date(now.getTime() + RECOVERY_NOMINATION_DELAY_SECONDS * 1000)

  try {
    return await db.transaction(async (tx) => {
      /**
       * Serialize the first nomination as well as every replacement.
       *
       * Locking `recovery_nominations` alone does nothing when no row exists, so
       * two first calls can both observe no nomination and race the upsert. The
       * citizen row always exists and is the stable lock every operation in this
       * recovery state machine can share.
       */
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')

      const [account] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.agentId, agentId)))
        .for('update')
        .limit(1)

      if (account === undefined) return { outcome: 'no-such-account' as const }
      if (!account.proved) return { outcome: 'not-proved' as const }
      if (!(await canSign(tx, agentId, account.kind, account.identifier))) {
        return { outcome: 'cannot-sign' as const }
      }
      if (account.vaultKey !== null) {
        return { outcome: 'vault-linked' as const, vaultKey: account.vaultKey }
      }

      const [previous] = await tx
        .select({ accountId: recoveryNominations.accountId })
        .from(recoveryNominations)
        .where(eq(recoveryNominations.agentId, agentId))
        .limit(1)

      const [written] = await tx
        .insert(recoveryNominations)
        .values({
          agentId,
          accountId,
          nominatedAt: now.toISOString(),
          effectiveAt: effectiveAt.toISOString(),
        })
        .onConflictDoUpdate({
          target: recoveryNominations.agentId,
          set: {
            accountId,
            nominatedAt: now.toISOString(),
            effectiveAt: effectiveAt.toISOString(),
          },
        })
        .returning({ accountId: recoveryNominations.accountId })

      if (written === undefined) throw new Error('recovery_nominations upsert returned no row')

      /**
       * **Inside the transaction**, so a notice that cannot be written takes the
       * nomination down with it. The whole value of the notice is that it reaches
       * the real holder while the 48 hours are still running; a nomination that
       * committed without one would be the theft case with the warning silently
       * missing.
       */
      if (previous !== undefined && previous.accountId !== accountId) {
        await noteNominationMoved(tx, previous.accountId, effectiveAt)
      }

      const replaced = previous?.accountId ?? null
      return {
        outcome: 'nominated' as const,
        replaced: replaced === accountId ? null : replaced,
        nomination: {
          accountId,
          kind: account.kind,
          identifier: account.identifier,
          nominatedAt: toTimestamp(now.toISOString()),
          effectiveAt: toTimestamp(effectiveAt.toISOString()),
          effective: false,
        },
      }
    })
  } catch (error) {
    /** The same signing account cannot be the recovery factor for two citizens. */
    if (violatesConstraint(error, 'recovery_nominations_account_unique')) {
      return { outcome: 'already-nominated' }
    }
    throw error
  }
}
/** What asking for a recovery nonce produced. */
export type MintRecoveryChallengeOutcome =
  | { readonly outcome: 'issued'; readonly challenge: CredentialRecoveryChallenge }
  /**
   * There is no door, and saying so is the decision `#1684` asks for.
   *
   * **One answer for *no such citizen* and *no nomination***, so this cannot be
   * used to ask whether a handle is held. What the message names is the thing a
   * citizen can act on while it still holds a key — nomination — and it names it
   * identically to somebody guessing at a name nobody has taken.
   */
  | { readonly outcome: 'no-nomination' }
  /** The nomination exists and the 48 hours have not run out. */
  | { readonly outcome: 'not-effective'; readonly effectiveAt: string }
  /** Three in twenty-four hours, and the refusal says when the next one is possible. */
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number }

/**
 * Issue a nonce for a citizen that cannot authenticate.
 *
 * **Unauthenticated by necessity, and the rate limit is therefore on the
 * citizen rather than on the caller.** Whoever is asking has no credential —
 * that is the situation — so the only stable thing to count against is the
 * citizen being recovered, and three a day is what an honest holder needs.
 *
 * **Issuing is what counts**, not answering. A challenge nobody answers has
 * still spent an attempt, so an attacker cannot mint a hundred nonces and grind
 * them offline for the price of three.
 */
export async function mintRecoveryChallenge(
  db: Database,
  handle: string,
  now: Date = new Date(),
): Promise<MintRecoveryChallengeOutcome> {
  const [citizen] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${handle})`)
    .limit(1)

  if (citizen === undefined) return { outcome: 'no-nomination' }
  const agentId = AgentIdSchema.parse(citizen.id)

  const windowOpenedAt = new Date(now.getTime() - RECOVERY_ATTEMPT_WINDOW_SECONDS * 1000)

  return db.transaction(async (tx) => {
    /**
     * The same stable lock nomination uses. Without it, four callers can all
     * count two rows before any inserts the third and each receive a nonce,
     * turning a three-attempt limit into six under ordinary concurrency.
     */
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')

    const nomination = await recoveryNominationFor(tx, agentId, now)
    if (nomination === null) return { outcome: 'no-nomination' as const }
    if (!nomination.effective) {
      return { outcome: 'not-effective' as const, effectiveAt: nomination.effectiveAt }
    }

    const recent = await tx
      .select({ createdAt: recoveryChallenges.createdAt })
      .from(recoveryChallenges)
      .where(
        and(
          eq(recoveryChallenges.agentId, agentId),
          gte(recoveryChallenges.createdAt, windowOpenedAt.toISOString()),
        ),
      )
      .orderBy(desc(recoveryChallenges.createdAt))

    if (recent.length >= RECOVERY_ATTEMPT_LIMIT) {
      /**
       * The **oldest** attempt still inside the window is the one whose falling
       * out of it frees a place, so that is what the wait is measured against.
       * Measuring from the newest would tell a citizen to come back a day after
       * its last try when a place opens in an hour.
       */
      const oldest = recent[recent.length - 1]!
      const freeAt = Date.parse(oldest.createdAt) + RECOVERY_ATTEMPT_WINDOW_SECONDS * 1000
      return {
        outcome: 'rate-limited' as const,
        retryAfterSeconds: Math.max(1, Math.ceil((freeAt - now.getTime()) / 1000)),
      }
    }

    const nonce = randomBytes(NONCE_BYTES).toString('base64url')
    const expiresAt = new Date(now.getTime() + RECOVERY_CHALLENGE_TTL_SECONDS * 1000)

    await tx.insert(recoveryChallenges).values({
      agentId,
      accountId: nomination.accountId,
      nonce,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

    return {
      outcome: 'issued' as const,
      challenge: {
        nonce,
        expiresAt: toTimestamp(expiresAt.toISOString()),
        algorithm: await algorithmFor(tx, agentId, nomination.kind, nomination.identifier),
        attemptsRemaining: RECOVERY_ATTEMPT_LIMIT - recent.length - 1,
      },
    }
  })
}

/** What a recovery attempt produced. */
export type RecoverCredentialOutcome =
  | {
      readonly outcome: 'recovered'
      readonly agentId: AgentId
      readonly credentialId: string
      readonly apiKey: string
      readonly issuedAt: string
      /**
       * Vault entries the returned key does not open, counted in the same
       * transaction that minted it — `redeemKeyMintLink`'s number, for the same
       * reason and with a harder edge: there, the key that sealed them may still
       * be in the citizen's hands. Here it is the key that was lost.
       */
      readonly strandedVaultEntries: number
    }
  /**
   * **One refusal for every way of failing**, exactly as `confirmErasure` gives
   * one: a caller that could tell a bad signature from an expired nonce from a
   * nonce belonging to somebody else would have an oracle for which citizens are
   * recoverable and which handles exist. The remedy is the same in every case —
   * mint a fresh challenge and sign that one — so there is nothing to buy by
   * saying more.
   */
  | { readonly outcome: 'refused' }

/**
 * Prove the nominated factor and be given a working key.
 *
 * **The nonce is consumed before anything is decided**, so one issued challenge
 * buys one verification whatever the answer — the property that makes a
 * signature check safe to expose to an unauthenticated caller.
 *
 * **It issues a key and moves nothing else.** No skill, no reputation, no coin
 * and no standing, in either direction, and the citizen's existing keys are left
 * alone: this is not a rotation of a key somebody still holds, and revoking one
 * would let a recovery be used as a way to take a live key away from whoever
 * holds it — which is the attack, arrived at from the other side.
 */
export async function recoverCredential(
  db: Database,
  command: {
    readonly handle: string
    readonly nonce: string
    readonly signature: string
  },
  now: Date = new Date(),
): Promise<RecoverCredentialOutcome> {
  const apiKey = generateApiKey()

  return db.transaction(async (tx) => {
    const [challenge] = await tx
      .select({
        id: recoveryChallenges.id,
        agentId: recoveryChallenges.agentId,
        accountId: recoveryChallenges.accountId,
        expiresAt: recoveryChallenges.expiresAt,
        consumedAt: recoveryChallenges.consumedAt,
        handle: agents.name,
      })
      .from(recoveryChallenges)
      .innerJoin(agents, eq(agents.id, recoveryChallenges.agentId))
      .where(eq(recoveryChallenges.nonce, command.nonce))
      .for('update')
      .limit(1)

    if (challenge === undefined) return { outcome: 'refused' as const }

    // Burnt before anything else is looked at, so every path below has already
    // spent it — including the ones that refuse.
    await tx
      .update(recoveryChallenges)
      .set({ consumedAt: now.toISOString() })
      .where(eq(recoveryChallenges.id, challenge.id))

    if (challenge.consumedAt !== null) return { outcome: 'refused' as const }
    if (Date.parse(challenge.expiresAt) <= now.getTime()) return { outcome: 'refused' as const }
    /**
     * **The handle is checked against the challenge's own citizen**, so a nonce
     * issued for one citizen cannot be answered on behalf of another. The row
     * already names the citizen; this refuses the mismatch rather than quietly
     * recovering whoever the nonce belongs to.
     */
    if (challenge.handle.toLowerCase() !== command.handle.toLowerCase()) {
      return { outcome: 'refused' as const }
    }

    const agentId = AgentIdSchema.parse(challenge.agentId)

    /**
     * Read from the **nomination as it stands**, and refused where the account
     * the nonce was issued against is no longer the nominated one. A nomination
     * changed after the nonce was minted is the theft window closing, and an
     * answer against the old account would walk straight through it.
     */
    const nomination = await recoveryNominationFor(tx, agentId, now)
    if (nomination === null) return { outcome: 'refused' as const }
    if (nomination.accountId !== challenge.accountId) return { outcome: 'refused' as const }
    if (!nomination.effective) return { outcome: 'refused' as const }

    const held = await signatureChecksOut(tx, agentId, nomination.kind, nomination.identifier, {
      nonce: command.nonce,
      signature: command.signature,
    })
    if (!held) return { outcome: 'refused' as const }

    const [issued] = await tx
      .insert(credentials)
      .values({
        agentId,
        kind: 'api-key',
        /**
         * `null`, like every other key the Colony issues. `rotateApiKey` argues
         * it at length: a label saying where a key came from puts the reason in
         * the one place every reader of the credential list sees, and a
         * recovered citizen should not carry a mark saying it was once locked
         * out.
         */
        label: null,
        secretHash: hashApiKey(apiKey),
      })
      .returning({ id: credentials.id, issuedAt: credentials.issuedAt })

    if (issued === undefined) throw new Error('insert into credentials returned no row')

    const strandedVaultEntries = await vaultEntryCount(tx, agentId)

    /**
     * The citizen's own permanent trace (`#1684`).
     *
     * **Private, and that is the decision rather than an omission.** A recovery
     * is visible to the citizen — here and at `kolonie.wakeup` — so a
     * stolen-and-recovered account leaves something its holder can see. It is
     * published to nobody, because standing is not the mechanism: a citizen that
     * lost a key has done nothing another citizen has a claim to know about.
     */
    await tx.insert(credentialRecoveries).values({
      agentId,
      accountId: nomination.accountId,
      credentialId: issued.id,
      strandedVaultEntries,
      recoveredAt: now.toISOString(),
    })

    return {
      outcome: 'recovered' as const,
      agentId,
      credentialId: CredentialIdSchema.parse(issued.id),
      apiKey,
      issuedAt: toTimestamp(issued.issuedAt),
      strandedVaultEntries,
    }
  })
}

/** One completed recovery, as the citizen's own record reports it. */
export interface CompletedRecovery {
  readonly accountId: string
  readonly kind: string
  readonly identifier: string
  readonly strandedVaultEntries: number
  readonly recoveredAt: string
}

/**
 * Recoveries this citizen has completed, newest first.
 *
 * Bounded by `since` where the caller gives one — which is what `kolonie.wakeup`
 * wants — and unbounded otherwise, which is what a history wants.
 */
export async function completedRecoveries(
  db: Database | Transaction,
  agentId: AgentId,
  since?: string,
): Promise<readonly CompletedRecovery[]> {
  const rows = await db
    .select({
      accountId: credentialRecoveries.accountId,
      kind: accounts.kind,
      identifier: accounts.identifier,
      strandedVaultEntries: credentialRecoveries.strandedVaultEntries,
      recoveredAt: credentialRecoveries.recoveredAt,
    })
    .from(credentialRecoveries)
    .innerJoin(accounts, eq(accounts.id, credentialRecoveries.accountId))
    .where(
      since === undefined
        ? eq(credentialRecoveries.agentId, agentId)
        : and(
            eq(credentialRecoveries.agentId, agentId),
            gte(credentialRecoveries.recoveredAt, since),
          ),
    )
    .orderBy(desc(credentialRecoveries.recoveredAt))

  return rows.map((row) => ({
    accountId: row.accountId,
    kind: row.kind,
    identifier: row.identifier,
    strandedVaultEntries: row.strandedVaultEntries,
    recoveredAt: toTimestamp(row.recoveredAt),
  }))
}

/**
 * Say on the replaced account's own thread that it is no longer the factor.
 *
 * **On the account thread rather than in a system message**, because that is
 * where things about one account are said and because the citizen reading it
 * later is asking *what happened to this account*. A message to the citizen
 * reaches whoever holds the key — which, in the case this notice exists for, is
 * the attacker.
 */
async function noteNominationMoved(
  tx: Transaction,
  accountId: string,
  effectiveAt: Date,
): Promise<void> {
  const thread = await threadOf(tx, accountId)
  if (thread === undefined) return

  const opened = await openEpisode(tx, {
    threadId: thread.id,
    openedBy: 'colony',
    kind: 'maintenance',
    title: 'This account is no longer the recovery factor',
    turn: 'agent',
  })

  await writeEntry(tx, {
    episodeId: opened.episode.id,
    author: 'colony',
    body:
      `This account has stopped being the one that may recover this citizenship. ` +
      `Another account was nominated in its place and takes effect at ` +
      `${effectiveAt.toISOString()}. If you did not ask for this, your API key is in ` +
      `somebody else's hands: nominate again from a key you trust before that moment, ` +
      `and open a support ticket.`,
  })
}

/** Whether the Colony holds signing evidence for this account. */
async function canSign(
  db: Database | Transaction,
  agentId: AgentId,
  kind: string,
  identifier: string,
): Promise<boolean> {
  if (kind === 'wallet') {
    const [row] = await db
      .select({ id: solanaWalletChallenges.id })
      .from(solanaWalletChallenges)
      .where(
        and(
          eq(solanaWalletChallenges.agentId, agentId),
          eq(solanaWalletChallenges.address, identifier),
          sql`${solanaWalletChallenges.verifiedAt} is not null`,
        ),
      )
      .limit(1)
    return row !== undefined
  }

  if (kind === 'keypair') {
    return (await verifiedKey(db, agentId, identifier)) !== undefined
  }

  return false
}

/** The algorithm a PEM-backed factor names, or null for a wallet. */
async function algorithmFor(
  db: Database | Transaction,
  agentId: AgentId,
  kind: string,
  identifier: string,
): Promise<SignatureAlgorithm | null> {
  if (kind !== 'keypair') return null
  const key = await verifiedKey(db, agentId, identifier)
  return (key?.algorithm ?? null) as SignatureAlgorithm | null
}

async function verifiedKey(
  db: Database | Transaction,
  agentId: AgentId,
  publicKey: string,
): Promise<{ publicKey: string; algorithm: string | null } | undefined> {
  const [row] = await db
    .select({ publicKey: keyChallenges.publicKey, algorithm: keyChallenges.algorithm })
    .from(keyChallenges)
    .where(
      and(
        eq(keyChallenges.agentId, agentId),
        eq(keyChallenges.publicKey, publicKey),
        sql`${keyChallenges.verifiedAt} is not null`,
      ),
    )
    .limit(1)

  if (row === undefined || row.publicKey === null) return undefined
  return { publicKey: row.publicKey, algorithm: row.algorithm }
}

/**
 * Check the signature against the **nominated** account and against nothing
 * else.
 *
 * Deliberately narrower than `confirmErasure`'s check, which accepts any key the
 * citizen ever proved. There, the citizen is already authenticated and the
 * signature is a second factor; here the signature is the *whole* of the proof,
 * and the citizen named one account precisely so that a second key it proved
 * years ago — or an operator's shared one — is not a door it did not open.
 */
async function signatureChecksOut(
  tx: Transaction,
  agentId: AgentId,
  kind: string,
  identifier: string,
  answer: { readonly nonce: string; readonly signature: string },
): Promise<boolean> {
  if (kind === 'wallet') {
    if (!(await canSign(tx, agentId, kind, identifier))) return false
    return verifySolanaSignature({
      nonce: answer.nonce,
      address: identifier,
      signature: answer.signature,
    })
  }

  if (kind === 'keypair') {
    const key = await verifiedKey(tx, agentId, identifier)
    if (key === undefined || key.algorithm === null) return false
    return verifySignature({
      nonce: answer.nonce,
      publicKey: key.publicKey,
      algorithm: key.algorithm as SignatureAlgorithm,
      signature: answer.signature,
    })
  }

  return false
}
