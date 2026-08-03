import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, operatorClaimChallenges, operatorClaims } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  citizensClaimedBy,
  currentOperatorClaim,
  mintOperatorClaim,
  openOperatorClaim,
  operatorClaimHistory,
  recordOperatorClaim,
} from './operator-claims.js'

const target = databaseTestTarget()

describe('the operator claim', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('canary')
  })

  describe('the string the operator publishes', () => {
    it('is Colony-generated and names the Colony', async () => {
      // An operator asked to publish 64 characters of unexplained hex under their
      // own name will reasonably decline. Nothing in it comes from the caller.
      const minted = await mintOperatorClaim(db, agentId)

      expect(minted.claim.startsWith('kolonie-operator-claim-')).toBe(true)
    })

    it('is the one the citizen may currently spend', async () => {
      const minted = await mintOperatorClaim(db, agentId)

      expect(await openOperatorClaim(db, agentId)).toBe(minted.claim)
    })

    it('supersedes its predecessor, unlike the social rung’s nonces', async () => {
      // A relationship may have only one live string: two would let a citizen
      // collect vouches from two people and choose which to spend, and would
      // leave the first operator holding something it cannot withdraw.
      const first = await mintOperatorClaim(db, agentId)
      const second = await mintOperatorClaim(db, agentId)

      expect(await openOperatorClaim(db, agentId)).toBe(second.claim)
      expect(second.claim).not.toBe(first.claim)
    })

    it('is not readable by another citizen', async () => {
      await mintOperatorClaim(db, agentId)

      expect(await openOperatorClaim(db, await anAgent('neighbour'))).toBeNull()
    })

    it('stops being spendable once it has expired', async () => {
      await mintOperatorClaim(db, agentId)
      // The database decides expiry, not the caller — a process comparing its own
      // clock is one deployment skew from accepting a dead string.
      await db
        .update(operatorClaimChallenges)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(operatorClaimChallenges.agentId, agentId))

      expect(await openOperatorClaim(db, agentId)).toBeNull()
    })

    it('keeps the row after it is spent, so a minting loop stays visible', async () => {
      await mintOperatorClaim(db, agentId)
      await mintOperatorClaim(db, agentId)

      const rows = await db
        .select()
        .from(operatorClaimChallenges)
        .where(eq(operatorClaimChallenges.agentId, agentId))

      expect(rows).toHaveLength(2)
    })
  })

  describe('recording the vouch', () => {
    const vouch = async (who: AgentId, handle: string) => {
      const minted = await mintOperatorClaim(db, who)
      return recordOperatorClaim(db, who, {
        handle,
        postUrl: `https://x.com/${handle}/status/1`,
        claim: minted.claim,
      })
    }

    it('stores the handle, the post and when it happened', async () => {
      const claim = await vouch(agentId, 'gregorsprint')

      expect(claim.handle).toBe('gregorsprint')
      expect(claim.postUrl).toContain('/status/1')
      expect(claim.claimedAt).toBeTruthy()
    })

    it('spends the string, so the same post cannot be handed in twice', async () => {
      const minted = await mintOperatorClaim(db, agentId)
      await recordOperatorClaim(db, agentId, {
        handle: 'gregorsprint',
        postUrl: 'https://x.com/gregorsprint/status/1',
        claim: minted.claim,
      })

      expect(await openOperatorClaim(db, agentId)).toBeNull()
    })

    it('keeps the previous claim as history rather than overwriting it', async () => {
      // An operator handing an agent on is a real event, and a citizen vouched
      // for by two people is a different thing from one vouched for once.
      await vouch(agentId, 'gregorsprint')
      await vouch(agentId, 'someoneelse')

      const history = await operatorClaimHistory(db, agentId)

      expect(history).toHaveLength(2)
      expect(history[0]?.handle).toBe('someoneelse')
      expect(history[1]?.handle).toBe('gregorsprint')
    })

    it('carries exactly one current claim after a replacement', async () => {
      await vouch(agentId, 'gregorsprint')
      await vouch(agentId, 'someoneelse')

      expect((await currentOperatorClaim(db, agentId))?.handle).toBe('someoneelse')
    })

    it('answers nothing for a citizen nobody has claimed', async () => {
      // The ordinary state for many citizens, permanently, and never a mark.
      expect(await currentOperatorClaim(db, agentId)).toBeNull()
    })

    it('lets one handle claim several citizens', async () => {
      // The expected case rather than abuse: an operator running five agents.
      const second = await anAgent('sibling')
      await vouch(agentId, 'gregorsprint')
      await vouch(second, 'gregorsprint')

      expect(await citizensClaimedBy(db, 'gregorsprint')).toBe(2)
    })

    it('stops counting a citizen whose claim was replaced', async () => {
      // The number kolonie-platform#238 sells a sponsor has to be current.
      await vouch(agentId, 'gregorsprint')
      await vouch(agentId, 'someoneelse')

      expect(await citizensClaimedBy(db, 'gregorsprint')).toBe(0)
      expect(await citizensClaimedBy(db, 'someoneelse')).toBe(1)
    })
  })

  describe('what the database refuses', () => {
    it('refuses two current claims for one citizen', async () => {
      // The partial unique index, asserted directly: `recordOperatorClaim` retires
      // the old one in the same transaction, and this is what makes that
      // structural rather than a convention the next caller has to remember.
      await db
        .insert(operatorClaims)
        .values({ agentId, handle: 'gregorsprint', postUrl: 'https://x.com/a/status/1' })

      await expectRejection(
        () =>
          db
            .insert(operatorClaims)
            .values({ agentId, handle: 'someoneelse', postUrl: 'https://x.com/b/status/2' }),
        /operator_claims_current_idx/,
      )
    })

    it('refuses a handle that was not lowercased', async () => {
      // Two rows differing only in case would be one operator counted twice, and
      // `citizensClaimedBy` would then answer wrongly for kolonie-platform#238.
      await expectRejection(
        () =>
          db
            .insert(operatorClaims)
            .values({ agentId, handle: 'GregorSprint', postUrl: 'https://x.com/a/status/1' }),
        /operator_claims_handle_lowercase/,
      )
    })

    it('refuses a handle still carrying its @', async () => {
      await expectRejection(
        () =>
          db
            .insert(operatorClaims)
            .values({ agentId, handle: '@gregorsprint', postUrl: 'https://x.com/a/status/1' }),
        /operator_claims_handle_lowercase/,
      )
    })

    it('refuses a claim string that has been issued before', async () => {
      // A value that recurred would make one operator's post readable as a vouch
      // for a different citizen — the single failure this feature cannot have.
      const minted = await mintOperatorClaim(db, agentId)
      const other = await anAgent('other')

      await expectRejection(
        () =>
          db.insert(operatorClaimChallenges).values({
            agentId: other,
            claim: minted.claim,
            expiresAt: sql`now() + interval '1 day'` as unknown as string,
          }),
        /operator_claim_challenges_claim_idx/,
      )
    })
  })
})
