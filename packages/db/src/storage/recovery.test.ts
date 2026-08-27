import { generateKeyPairSync, randomUUID, sign as signWith } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  RECOVERY_ATTEMPT_LIMIT,
  RegisterAgentRequestSchema,
  encodeBase58,
  SOLANA_ADDRESS_BYTES,
  type AccountCapability,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { generateApiKey } from '../api-key.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  accounts,
  agents,
  credentialRecoveries,
  credentials,
  keyChallenges,
  recoveryChallenges,
  solanaWalletChallenges,
} from '../schema/index.js'
import { entriesOf, openEpisodesFor } from './account-threads.js'
import { recordProvedAccount, setAccountVaultKey } from './accounts.js'
import { registerAgent } from './agents.js'
import { authenticateApiKey } from './authentication.js'
import { reputationOfAgent } from './balance.js'
import { skillsOfAgent } from './skills.js'
import { getVaultEntry, setVaultEntry } from './vault.js'
import { recoveryNominationFor, vaultKeyOpensNominatedAccount } from './recovery-nominations.js'
import * as recovery from './recovery.js'
import {
  completedRecoveries,
  mintRecoveryChallenge,
  nominateRecoveryAccount,
  recoverCredential,
} from './recovery.js'

const target = databaseTestTarget()

/**
 * Recovery, nominated in advance (`#1684`).
 *
 * **Almost every test here is a refusal**, in the same proportion
 * `erasure-confirmation.test.ts` has and for a sharper reason: this surface is
 * unauthenticated by necessity, so the set of things that must not get through
 * it *is* the feature.
 */
describe('recovering a lost key', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('canary')
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /** A keypair the way an agent that cleared `key-signature` holds one. */
  const aKeypair = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    return {
      pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: (message: string) =>
        signWith(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
    }
  }

  /** A wallet, as `solana.test.ts` builds one: base58 address, base58 signature. */
  const aWallet = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const spki = publicKey.export({ type: 'spki', format: 'der' })
    return {
      address: encodeBase58(Uint8Array.from(spki.subarray(spki.length - SOLANA_ADDRESS_BYTES))),
      sign: (message: string) =>
        encodeBase58(Uint8Array.from(signWith(null, Buffer.from(message, 'utf8'), privateKey))),
    }
  }

  /** The cleared `key-signature` row plus the account row a verdict projects. */
  const provedKeypair = async (owner: AgentId = agentId) => {
    const key = aKeypair()
    await db.insert(keyChallenges).values({
      agentId: owner,
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      algorithm: 'ed25519',
      publicKey: key.pem,
      signature: 'the one that cleared the rung',
      verifiedAt: new Date().toISOString(),
    })
    const account = await recordProvedAccount(db, owner, {
      kind: AccountKindSchema.parse('keypair'),
      identifier: key.pem,
      capabilities: ['sign'] as unknown as readonly AccountCapability[],
      provedAt: new Date().toISOString(),
    })
    return { ...key, account }
  }

  const provedWallet = async (owner: AgentId = agentId) => {
    const wallet = aWallet()
    await db.insert(solanaWalletChallenges).values({
      agentId: owner,
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      address: wallet.address,
      signature: 'the one that cleared the rung',
      verifiedAt: new Date().toISOString(),
    })
    const account = await recordProvedAccount(db, owner, {
      kind: AccountKindSchema.parse('wallet'),
      identifier: wallet.address,
      capabilities: ['sign'] as unknown as readonly AccountCapability[],
      provedAt: new Date().toISOString(),
    })
    return { ...wallet, account }
  }

  /** A mailbox: proved, and unable to sign anything. */
  const provedMailbox = async (identifier = 'canary@example.org') =>
    recordProvedAccount(db, agentId, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier,
      capabilities: ['receive'] as unknown as readonly AccountCapability[],
      provedAt: new Date().toISOString(),
    })

  /** Move a nomination into the past, so the 48 hours have run. */
  const ageTheNomination = async (owner: AgentId = agentId) => {
    await db.execute(sql`
      update recovery_nominations
         set nominated_at = now() - interval '10 days',
             effective_at = now() - interval '8 days'
       where agent_id = ${owner}`)
  }

  const nominatedAndEffective = async () => {
    const key = await provedKeypair()
    await nominateRecoveryAccount(db, agentId, key.account.id)
    await ageTheNomination()
    return key
  }

  describe('nominating the one account that may recover', () => {
    it('records one account, not yet effective, forty-eight hours out', async () => {
      const key = await provedKeypair()

      const result = await nominateRecoveryAccount(db, agentId, key.account.id)

      expect(result).toMatchObject({ outcome: 'nominated', replaced: null })
      if (result.outcome !== 'nominated') return
      expect(result.nomination.effective).toBe(false)
      const window =
        Date.parse(result.nomination.effectiveAt) - Date.parse(result.nomination.nominatedAt)
      expect(window).toBe(48 * 60 * 60 * 1000)
    })

    it('replaces the first when a second is nominated, and restarts the window', async () => {
      const first = await provedKeypair()
      const second = await provedWallet()
      await nominateRecoveryAccount(db, agentId, first.account.id)
      await ageTheNomination()

      const result = await nominateRecoveryAccount(db, agentId, second.account.id)

      expect(result).toMatchObject({ outcome: 'nominated', replaced: first.account.id })
      const held = await recoveryNominationFor(db, agentId)
      // Exactly one, and the clock started again — an attacker holding a stolen
      // key cannot nominate itself and use it in the same session.
      expect(held).toMatchObject({ accountId: second.account.id, effective: false })
    })

    /**
     * The anti-theft notice, and it is written where things about an account are
     * said rather than to whoever currently holds the key — which, in the case
     * this exists for, is the attacker.
     */
    it('writes to the account it replaced, inside the window', async () => {
      const first = await provedKeypair()
      const second = await provedWallet()
      await nominateRecoveryAccount(db, agentId, first.account.id)

      await nominateRecoveryAccount(db, agentId, second.account.id)

      const episodes = await openEpisodesFor(db, agentId)
      const onReplaced = episodes.filter((open) => open.account.id === first.account.id)
      expect(onReplaced).toHaveLength(1)
      const written = await entriesOf(db, onReplaced[0]!.episode.id)
      expect(written[0]?.body).toContain('stopped being')
      expect(written[0]?.body).toContain('support ticket')
    })

    it('writes nothing anywhere when the same account is nominated again', async () => {
      const key = await provedKeypair()
      await nominateRecoveryAccount(db, agentId, key.account.id)

      const again = await nominateRecoveryAccount(db, agentId, key.account.id)

      expect(again).toMatchObject({ outcome: 'nominated', replaced: null })
      expect(await openEpisodesFor(db, agentId)).toEqual([])
    })

    it('refuses an account that is not this citizen’s', async () => {
      const other = await register('somebody-else')
      const theirs = await provedKeypair(other)

      expect(await nominateRecoveryAccount(db, agentId, theirs.account.id)).toEqual({
        outcome: 'no-such-account',
      })
    })

    it('refuses an account the Colony never verified', async () => {
      const [declared] = await db
        .insert(accounts)
        .values({ agentId, kind: 'keypair', identifier: 'a claim and nothing more' })
        .returning({ id: accounts.id })

      expect(await nominateRecoveryAccount(db, agentId, declared!.id)).toEqual({
        outcome: 'not-proved',
      })
    })

    /**
     * A mailbox is proved and cannot sign, and mailbox recovery is excluded by
     * `#1684` outright. Refused at nomination rather than at the attempt: the
     * attempt happens on the day the citizen has no other way in.
     */
    it('refuses a proved account that cannot sign anything', async () => {
      const mailbox = await provedMailbox()

      expect(await nominateRecoveryAccount(db, agentId, mailbox.id)).toEqual({
        outcome: 'cannot-sign',
      })
    })

    /**
     * The circular dependency, refused (`#1684`, 2026-08-24). An account whose
     * credential is in the vault dies at the same instant, by the same cause, as
     * the key the nomination exists to survive.
     */
    it('refuses an account a vault entry opens, and names the entry', async () => {
      const key = await provedKeypair()
      await setAccountVaultKey(db, agentId, key.account.id, 'keys/signing')

      expect(await nominateRecoveryAccount(db, agentId, key.account.id)).toEqual({
        outcome: 'vault-linked',
        vaultKey: 'keys/signing',
      })
    })

    it('reports a nomination as effective once the window has passed', async () => {
      const key = await provedKeypair()
      await nominateRecoveryAccount(db, agentId, key.account.id)
      await ageTheNomination()

      expect(await recoveryNominationFor(db, agentId)).toMatchObject({ effective: true })
    })

    it('says a citizen with no nomination has none', async () => {
      expect(await recoveryNominationFor(db, agentId)).toBeNull()
    })

    /** What `kolonie.vault.set` asks before it writes. */
    it('refuses linking the nominated account to a vault entry', async () => {
      const key = await provedKeypair()
      await nominateRecoveryAccount(db, agentId, key.account.id)

      expect(await setAccountVaultKey(db, agentId, key.account.id, 'keys/signing')).toEqual({
        outcome: 'recovery_factor_has_no_vault_key',
      })
    })

    it('refuses the vault write that would strand the nominated account', async () => {
      const key = await provedKeypair()
      await nominateRecoveryAccount(db, agentId, key.account.id)
      await db
        .update(accounts)
        .set({ vaultKey: 'keys/signing' })
        .where(eq(accounts.id, key.account.id))

      const token = String(generateApiKey())
      expect(await setVaultEntry(db, token, agentId, 'keys/signing', 'the factor')).toEqual({
        outcome: 'recovery-factor',
      })
      expect(await getVaultEntry(db, token, agentId, 'keys/signing')).toEqual({
        outcome: 'unknown',
      })
    })

    it('knows which vault name would open the nominated account', async () => {
      const key = await provedKeypair()
      await nominateRecoveryAccount(db, agentId, key.account.id)
      // Written past `setAccountVaultKey`, which refuses this pair: the guard is
      // what this read backs up, so the state has to be forced to test it.
      await db
        .update(accounts)
        .set({ vaultKey: 'keys/signing' })
        .where(eq(accounts.id, key.account.id))

      expect(await vaultKeyOpensNominatedAccount(db, agentId, 'keys/signing')).toBe(true)
      expect(await vaultKeyOpensNominatedAccount(db, agentId, 'keys/other')).toBe(false)
    })
  })

  describe('asking for a nonce', () => {
    it('issues one for a citizen whose nomination has taken effect', async () => {
      await nominatedAndEffective()

      const minted = await mintRecoveryChallenge(db, 'canary')

      expect(minted.outcome).toBe('issued')
      if (minted.outcome !== 'issued') return
      expect(minted.challenge.algorithm).toBe('ed25519')
      expect(minted.challenge.attemptsRemaining).toBe(RECOVERY_ATTEMPT_LIMIT - 1)
      expect(Date.parse(minted.challenge.expiresAt) - Date.now()).toBeLessThanOrEqual(
        15 * 60 * 1000,
      )
    })

    it('names no algorithm for a wallet, which signs without one', async () => {
      const wallet = await provedWallet()
      await nominateRecoveryAccount(db, agentId, wallet.account.id)
      await ageTheNomination()

      const minted = await mintRecoveryChallenge(db, 'canary')

      expect(minted).toMatchObject({ outcome: 'issued' })
      if (minted.outcome !== 'issued') return
      expect(minted.challenge.algorithm).toBeNull()
    })

    it('refuses a citizen that never nominated, naming nomination', async () => {
      expect(await mintRecoveryChallenge(db, 'canary')).toEqual({ outcome: 'no-nomination' })
    })

    /**
     * **A handle nobody holds answers exactly as a citizen with no nomination.**
     * The call is unauthenticated, so a distinguishable answer would be a way to
     * ask whether a name is taken and whether that citizen is recoverable.
     */
    it('answers identically for a handle nobody holds', async () => {
      expect(await mintRecoveryChallenge(db, 'nobody-by-that-name')).toEqual(
        await mintRecoveryChallenge(db, 'canary'),
      )
    })

    it('refuses while the forty-eight hours are still running', async () => {
      const key = await provedKeypair()
      await nominateRecoveryAccount(db, agentId, key.account.id)

      const minted = await mintRecoveryChallenge(db, 'canary')

      expect(minted.outcome).toBe('not-effective')
    })

    it('finds the citizen whatever the case of the handle', async () => {
      await nominatedAndEffective()

      expect((await mintRecoveryChallenge(db, 'CANARY')).outcome).toBe('issued')
    })

    /** Three a day, counted at issue: a nonce nobody answers has still been spent. */
    it('allows three in twenty-four hours and then says when the next is possible', async () => {
      await nominatedAndEffective()

      for (let i = 0; i < RECOVERY_ATTEMPT_LIMIT; i += 1) {
        expect((await mintRecoveryChallenge(db, 'canary')).outcome).toBe('issued')
      }
      const refused = await mintRecoveryChallenge(db, 'canary')

      expect(refused.outcome).toBe('rate-limited')
      if (refused.outcome !== 'rate-limited') return
      expect(refused.retryAfterSeconds).toBeGreaterThan(0)
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(24 * 60 * 60)
    })

    it('never exceeds three attempts when challenge requests race', async () => {
      await nominatedAndEffective()

      const results = await Promise.all(
        Array.from({ length: RECOVERY_ATTEMPT_LIMIT + 1 }, () =>
          mintRecoveryChallenge(db, 'canary'),
        ),
      )

      expect(results.filter((result) => result.outcome === 'issued')).toHaveLength(
        RECOVERY_ATTEMPT_LIMIT,
      )
      expect(results.filter((result) => result.outcome === 'rate-limited')).toHaveLength(1)
    })

    it('counts only the attempts inside the window', async () => {
      await nominatedAndEffective()
      for (let i = 0; i < RECOVERY_ATTEMPT_LIMIT; i += 1) await mintRecoveryChallenge(db, 'canary')
      await db.execute(sql`
        update recovery_challenges
           set created_at = now() - interval '25 hours',
               expires_at = now() - interval '24 hours'`)

      expect((await mintRecoveryChallenge(db, 'canary')).outcome).toBe('issued')
    })

    it('counts attempts per citizen and not across the Colony', async () => {
      await nominatedAndEffective()
      const other = await register('neighbour')
      const theirs = await provedKeypair(other)
      await nominateRecoveryAccount(db, other, theirs.account.id)
      await ageTheNomination(other)

      for (let i = 0; i < RECOVERY_ATTEMPT_LIMIT; i += 1) await mintRecoveryChallenge(db, 'canary')

      expect((await mintRecoveryChallenge(db, 'neighbour')).outcome).toBe('issued')
    })
  })

  describe('answering with a signature', () => {
    const mint = async (handle = 'canary') => {
      const minted = await mintRecoveryChallenge(db, handle)
      if (minted.outcome !== 'issued') throw new Error(`expected a nonce, got ${minted.outcome}`)
      return minted.challenge
    }

    it('gives a working key back for a good signature over the nonce', async () => {
      const key = await nominatedAndEffective()
      const challenge = await mint()

      const recovered = await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })

      expect(recovered.outcome).toBe('recovered')
      if (recovered.outcome !== 'recovered') return
      expect(recovered.agentId).toBe(agentId)
      const authenticated = await authenticateApiKey(db, recovered.apiKey)
      expect(authenticated).toMatchObject({ outcome: 'authenticated' })
    })

    it('recovers a wallet-nominated citizen through the base58 path', async () => {
      const wallet = await provedWallet()
      await nominateRecoveryAccount(db, agentId, wallet.account.id)
      await ageTheNomination()
      const challenge = await mint()

      const recovered = await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: wallet.sign(challenge.nonce),
      })

      expect(recovered.outcome).toBe('recovered')
    })

    it('refuses a bad signature and issues nothing', async () => {
      await nominatedAndEffective()
      const attacker = aKeypair()
      const challenge = await mint()

      const refused = await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: attacker.sign(challenge.nonce),
      })

      expect(refused).toEqual({ outcome: 'refused' })
      expect(await liveKeys()).toHaveLength(1)
    })

    it('refuses a good signature over a different message', async () => {
      const key = await nominatedAndEffective()
      const challenge = await mint()

      expect(
        await recoverCredential(db, {
          handle: 'canary',
          nonce: challenge.nonce,
          signature: key.sign('a nonce the Colony issued last week'),
        }),
      ).toEqual({ outcome: 'refused' })
    })

    it('refuses an expired nonce', async () => {
      const key = await nominatedAndEffective()
      const challenge = await mint()
      await db
        .update(recoveryChallenges)
        .set({
          createdAt: sql`now() - interval '2 hours'`,
          expiresAt: sql`now() - interval '1 hour'`,
        })
        .where(eq(recoveryChallenges.nonce, challenge.nonce))

      expect(
        await recoverCredential(db, {
          handle: 'canary',
          nonce: challenge.nonce,
          signature: key.sign(challenge.nonce),
        }),
      ).toEqual({ outcome: 'refused' })
      expect(await liveKeys()).toHaveLength(1)
    })

    /** One issued challenge buys one verification, whatever the answer. */
    it('refuses a nonce that has already been used', async () => {
      const key = await nominatedAndEffective()
      const challenge = await mint()

      const first = await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })
      const second = await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })

      expect(first.outcome).toBe('recovered')
      expect(second).toEqual({ outcome: 'refused' })
    })

    it('spends the nonce even when the signature was wrong', async () => {
      const key = await nominatedAndEffective()
      const attacker = aKeypair()
      const challenge = await mint()

      await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: attacker.sign(challenge.nonce),
      })
      const afterwards = await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })

      expect(afterwards).toEqual({ outcome: 'refused' })
    })

    it('refuses a nonce issued for another citizen', async () => {
      const other = await register('neighbour')
      const theirs = await provedKeypair(other)
      await nominateRecoveryAccount(db, other, theirs.account.id)
      await ageTheNomination(other)
      await nominatedAndEffective()
      const challenge = await mint('neighbour')

      const refused = await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: theirs.sign(challenge.nonce),
      })

      expect(refused).toEqual({ outcome: 'refused' })
      expect(await liveKeys()).toHaveLength(1)
      expect(await liveKeys(other)).toHaveLength(1)
    })

    it('refuses a nonce nobody minted', async () => {
      const key = await nominatedAndEffective()

      expect(
        await recoverCredential(db, {
          handle: 'canary',
          nonce: 'a nonce that was never issued',
          signature: key.sign('a nonce that was never issued'),
        }),
      ).toEqual({ outcome: 'refused' })
    })

    /**
     * The theft window closing. A nomination changed after the nonce was minted
     * makes that nonce answer for an account the citizen has just stopped
     * trusting.
     */
    it('refuses a nonce minted against an account no longer nominated', async () => {
      const key = await nominatedAndEffective()
      const challenge = await mint()
      const second = await provedWallet()
      await nominateRecoveryAccount(db, agentId, second.account.id)

      expect(
        await recoverCredential(db, {
          handle: 'canary',
          nonce: challenge.nonce,
          signature: key.sign(challenge.nonce),
        }),
      ).toEqual({ outcome: 'refused' })
    })

    /** Every refusal is the same object, so nothing here is an oracle. */
    it('gives one indistinguishable answer to every way of failing', async () => {
      const key = await nominatedAndEffective()
      const attacker = aKeypair()
      const expired = await mint()
      await db
        .update(recoveryChallenges)
        .set({
          createdAt: sql`now() - interval '2 hours'`,
          expiresAt: sql`now() - interval '1 hour'`,
        })
        .where(eq(recoveryChallenges.nonce, expired.nonce))
      const wrongSignature = await mint()

      const refusals = [
        await recoverCredential(db, { handle: 'canary', nonce: 'nothing', signature: 'x' }),
        await recoverCredential(db, {
          handle: 'canary',
          nonce: expired.nonce,
          signature: key.sign(expired.nonce),
        }),
        await recoverCredential(db, {
          handle: 'canary',
          nonce: wrongSignature.nonce,
          signature: attacker.sign(wrongSignature.nonce),
        }),
      ]

      for (const refusal of refusals) expect(refusal).toEqual({ outcome: 'refused' })
    })
  })

  describe('what a recovery moves, and what it does not', () => {
    it('moves no skill, no reputation and nothing about the citizen', async () => {
      const key = await nominatedAndEffective()
      const before = {
        skills: await skillsOfAgent(db, agentId),
        reputation: await reputationOfAgent(db, agentId),
      }
      const challenge = await mintOne()

      await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })

      expect(await skillsOfAgent(db, agentId)).toEqual(before.skills)
      expect(await reputationOfAgent(db, agentId)).toEqual(before.reputation)
    })

    /**
     * **Not a rotation.** Revoking a live key here would let a recovery be used
     * to take a working key away from whoever holds it — which is the attack,
     * arrived at from the other side.
     */
    it('leaves every existing key alone', async () => {
      const key = await nominatedAndEffective()
      const existing = await liveKeys()
      const challenge = await mintOne()

      await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })

      const after = await liveKeys()
      expect(after).toHaveLength(existing.length + 1)
      expect(after.map((row) => row.id)).toEqual(expect.arrayContaining([existing[0]!.id]))
    })

    /**
     * The structural loss, counted rather than repaired: the old key is a hash,
     * so there is nothing to decrypt the entries with and no plumbing changes
     * that.
     */
    it('counts the vault entries the new key will not open', async () => {
      const key = await nominatedAndEffective()
      const lost = String(generateApiKey())
      await setVaultEntry(db, lost, agentId, 'mailbox', 'a password')
      await setVaultEntry(db, lost, agentId, 'github', 'a token')
      const challenge = await mintOne()

      const recovered = await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })

      expect(recovered).toMatchObject({ outcome: 'recovered', strandedVaultEntries: 2 })
      if (recovered.outcome !== 'recovered') return
      expect(await getVaultEntry(db, recovered.apiKey, agentId, 'mailbox')).toMatchObject({
        outcome: 'unreadable',
      })
    })

    it('records the recovery on the citizen’s own history', async () => {
      const key = await nominatedAndEffective()
      const challenge = await mintOne()

      await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })

      const history = await completedRecoveries(db, agentId)
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ kind: 'keypair', strandedVaultEntries: 0 })
    })

    it('reports nothing for a citizen that never recovered, and nothing of anybody else’s', async () => {
      const key = await nominatedAndEffective()
      const other = await register('neighbour')
      const challenge = await mintOne()
      await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })

      expect(await completedRecoveries(db, other)).toEqual([])
    })

    /** What `kolonie.wakeup` asks: only what happened in the window. */
    it('reports a recovery to a window that contains it and not to one that does not', async () => {
      const key = await nominatedAndEffective()
      const challenge = await mintOne()
      await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })

      const since = new Date(Date.now() - 60_000).toISOString()
      const later = new Date(Date.now() + 60_000).toISOString()
      expect(await completedRecoveries(db, agentId, since)).toHaveLength(1)
      expect(await completedRecoveries(db, agentId, later)).toEqual([])
    })
  })

  /**
   * The history is append-only, and the two halves of that are held in two
   * different places (`#1721`).
   *
   * `#1684` left it to the storage surface exposing no update path, which is a
   * promise about today's code. What is asserted here is the pair that
   * `account_entries` already carries: the database refuses to change a row, so
   * the guarantee survives a caller that writes its own `UPDATE`; and it
   * deliberately does **not** refuse a delete, because erasure reaches these
   * rows by cascade and a row-level delete guard would refuse erasure itself.
   */
  describe('a completed recovery cannot be rewritten', () => {
    /** One recovery on the record, through the real path that writes one. */
    const aCompletedRecovery = async () => {
      const key = await nominatedAndEffective()
      const challenge = await mintOne()
      const recovered = await recoverCredential(db, {
        handle: 'canary',
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      })
      if (recovered.outcome !== 'recovered') throw new Error(recovered.outcome)

      const [row] = await db
        .select({ id: credentialRecoveries.id })
        .from(credentialRecoveries)
        .where(eq(credentialRecoveries.agentId, agentId))
      if (row === undefined) throw new Error('the recovery wrote no row')
      return row.id
    }

    it('is refused by the table when an update goes around this module', async () => {
      const id = await aCompletedRecovery()

      await expectRejection(
        () =>
          db
            .update(credentialRecoveries)
            .set({ strandedVaultEntries: 99 })
            .where(eq(credentialRecoveries.id, id)),
        /append-only/,
      )
      expect(await completedRecoveries(db, agentId)).toMatchObject([{ strandedVaultEntries: 0 }])
    })

    /**
     * The stamp as much as the count: a recovery moved in time would put the
     * event outside the window `kolonie.wakeup` reads, which is the quietest
     * possible way to hide one from the citizen it happened to.
     */
    it('refuses a change to when it happened', async () => {
      const id = await aCompletedRecovery()

      await expectRejection(
        () =>
          db
            .update(credentialRecoveries)
            .set({ recoveredAt: new Date(Date.now() - 30 * 86_400_000).toISOString() })
            .where(eq(credentialRecoveries.id, id)),
        /append-only/,
      )
      expect(
        await completedRecoveries(db, agentId, new Date(Date.now() - 60_000).toISOString()),
      ).toHaveLength(1)
    })

    /**
     * **Asserted over the module's exports** rather than by calling something
     * and expecting it to fail, exactly as `account-threads.test.ts` asserts the
     * same property: what is being checked is that a caller reading this module
     * finds nothing to reach for.
     */
    it('offers no way to change one and no way to remove one', () => {
      const named = Object.keys(recovery).filter((name) => /recover/i.test(name))

      expect(named.sort()).toEqual([
        'completedRecoveries',
        'mintRecoveryChallenge',
        'nominateRecoveryAccount',
        'recoverCredential',
      ])
    })

    /**
     * Refusing an update must not become refusing a delete: erasure reaches
     * these rows by cascade, and a trigger that refused it would refuse erasure.
     */
    it('goes with the citizen when the agent is erased', async () => {
      await aCompletedRecovery()

      await db.delete(agents).where(eq(agents.id, agentId))

      const [remaining] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(credentialRecoveries)
      expect(remaining?.count).toBe(0)
    })
  })

  const mintOne = async () => {
    const minted = await mintRecoveryChallenge(db, 'canary')
    if (minted.outcome !== 'issued') throw new Error(`expected a nonce, got ${minted.outcome}`)
    return minted.challenge
  }

  const liveKeys = async (owner: AgentId = agentId) =>
    db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        sql`${credentials.agentId} = ${owner} and ${credentials.kind} = 'api-key'
            and ${credentials.revokedAt} is null`,
      )
})
