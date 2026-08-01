import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  CAPABILITY_STAGE,
  RegisterAgentRequestSchema,
  RETIRED_CHALLENGE_STAGE,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { browserChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  advanceChallenge,
  challengeProgress,
  hasClearedGate,
  mintChallenge,
  redeemChallenge,
} from './challenges.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('browser challenges', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('gatekeeper')
    otherId = await register('bystander')
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /**
   * Age a row into the past — minting cannot produce an expired one.
   *
   * Both timestamps move, because `browser_challenges_expiry_after_creation`
   * refuses a row whose expiry precedes its creation. Writing this helper the
   * obvious way is how that constraint first proved it was doing something.
   */
  const expire = async (challengeId: string) => {
    await db
      .update(browserChallenges)
      .set({
        createdAt: sql`now() - interval '2 minutes'`,
        expiresAt: sql`now() - interval '1 minute'`,
      })
      .where(eq(browserChallenges.id, challengeId))
  }

  /**
   * A row of the retired stage, written directly.
   *
   * **`mintChallenge` refuses it now** (`#160`), which is the behaviour a separate
   * test below asserts. The redemption path it was cleared through still has to
   * work — a challenge minted in the ten minutes before that deploy is one a
   * citizen is entitled to finish — so these tests exercise it against rows they
   * insert rather than against a mint that is correctly gone.
   */
  const aRetiredChallenge = async (owner: AgentId = agentId): Promise<{ id: string }> => {
    const [row] = await db
      .insert(browserChallenges)
      .values({
        agentId: owner,
        kind: RETIRED_CHALLENGE_STAGE,
        stepsRequired: 0,
        expiresAt: sql`now() + interval '10 minutes'`,
      })
      .returning({ id: browserChallenges.id })
    if (row === undefined) throw new Error('insert returned no row')
    return row
  }

  it('refuses to mint the retired stage, and says which stages remain', async () => {
    await expect(mintChallenge(db, agentId, RETIRED_CHALLENGE_STAGE)).rejects.toThrow(/retired/)
  })

  it('mints a challenge that is unsolved and in the future', async () => {
    const minted = await mintChallenge(db, agentId, CAPABILITY_STAGE)

    expect(minted.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.now())
    expect(await hasClearedGate(db, agentId, CAPABILITY_STAGE)).toBeNull()
  })

  it('leaves an unminted stage unrecorded for its owner', async () => {
    await aRetiredChallenge()

    expect(await hasClearedGate(db, agentId, RETIRED_CHALLENGE_STAGE)).toBeNull()
  })

  it('credits the agent that minted the challenge, never the caller', async () => {
    const minted = await aRetiredChallenge()

    const redeemed = await redeemChallenge(db, minted.id)

    expect(redeemed).toEqual({ outcome: 'verified', agentId })
    expect(await hasClearedGate(db, agentId, RETIRED_CHALLENGE_STAGE)).toBeTruthy()
    // The other agent solved nothing, and holding the id would not have helped.
    expect(await hasClearedGate(db, otherId, RETIRED_CHALLENGE_STAGE)).toBeNull()
  })

  it('tells apart an unknown id, an expired one and one already used', async () => {
    expect(await redeemChallenge(db, crypto.randomUUID())).toEqual({ outcome: 'unknown' })

    const used = await aRetiredChallenge()
    await redeemChallenge(db, used.id)
    expect(await redeemChallenge(db, used.id)).toEqual({ outcome: 'already_verified' })

    const stale = await aRetiredChallenge()
    await expire(stale.id)
    expect(await redeemChallenge(db, stale.id)).toEqual({ outcome: 'expired' })
  })

  /**
   * Single-use is a condition in the `UPDATE … WHERE`, not a read followed by a
   * write, so two form submissions arriving together cannot both succeed. This
   * is the property the fake in `apps/api` cannot model, and the reason this
   * test needs a real database.
   */
  it('lets exactly one of two concurrent redemptions win', async () => {
    const minted = await aRetiredChallenge()

    const results = await Promise.all([
      redeemChallenge(db, minted.id),
      redeemChallenge(db, minted.id),
    ])

    expect(results.filter((r) => r.outcome === 'verified')).toHaveLength(1)
    expect(results.filter((r) => r.outcome === 'already_verified')).toHaveLength(1)
  })

  it('rejects a malformed id without letting Postgres raise', async () => {
    // The id arrives from a form field, which means it arrives from anywhere.
    expect(await redeemChallenge(db, 'not-a-uuid')).toEqual({ outcome: 'unknown' })
    expect(await redeemChallenge(db, "'; drop table agents; --")).toEqual({ outcome: 'unknown' })
  })

  /**
   * The capability the gate proves does not lapse when the challenge that proved
   * it expires. An agent that cleared it last week and submits today passes.
   */
  /**
   * Written as a historical row rather than by ageing a fresh one, because
   * ageing is not what happens: `expires_at` is fixed at mint and it is *now*
   * that moves past it. A week-old challenge solved two minutes after it was
   * opened is the real shape, and it satisfies both check constraints.
   */
  it('keeps a pass long after the challenge that earned it has expired', async () => {
    await db.insert(browserChallenges).values({
      agentId,
      kind: RETIRED_CHALLENGE_STAGE,
      // Zero, because that is what this stage's cleared rows actually carry: it was
      // cleared by a redemption, never by reported steps. Omitting it takes the
      // column default of 3 and `browser_challenges_complete_when_verified`
      // correctly refuses the row — which is how this test proved the constraint
      // does something when `#160` added it.
      stepsRequired: 0,
      createdAt: sql`now() - interval '7 days'`,
      expiresAt: sql`now() - interval '7 days' + interval '10 minutes'`,
      verifiedAt: sql`now() - interval '7 days' + interval '2 minutes'`,
    })

    expect(await hasClearedGate(db, agentId, RETIRED_CHALLENGE_STAGE)).toBeTruthy()
  })

  it('refuses at the database to record a solve after expiry', async () => {
    const minted = await aRetiredChallenge()
    await expire(minted.id)

    // The check constraint is the backstop under the endpoint's own guard: this
    // is the constraint the whole gate rests on, so it is stated in SQL too.
    await expect(
      db
        .update(browserChallenges)
        .set({ verifiedAt: sql`now()` })
        .where(eq(browserChallenges.id, minted.id)),
    ).rejects.toThrow()
  })
  /**
   * The two kinds share this table and must never satisfy each other. Without
   * `kind` in every read, clearing the easy capability page would hand out the
   * hCaptcha badge for work nobody did — which is the entire reason the column
   * exists rather than a single "cleared" flag.
   */
  it('keeps the two kinds from answering for each other', async () => {
    const capability = await mintChallenge(db, agentId, CAPABILITY_STAGE)
    for (let step = 0; step < 3; step += 1)
      await advanceChallenge(db, capability.id, step, CAPABILITY_STAGE)

    expect(await hasClearedGate(db, agentId, CAPABILITY_STAGE)).toBeTruthy()
    expect(await hasClearedGate(db, agentId, RETIRED_CHALLENGE_STAGE)).toBeNull()
    // And the badge's redemption does not recognise the capability row at all.
    expect(await redeemChallenge(db, capability.id)).toEqual({ outcome: 'unknown' })
  })

  it('clears a capability challenge only on its last step', async () => {
    const minted = await mintChallenge(db, agentId, CAPABILITY_STAGE)

    expect(await advanceChallenge(db, minted.id, 0, CAPABILITY_STAGE)).toMatchObject({
      outcome: 'advanced',
      steps: 1,
    })
    expect(await advanceChallenge(db, minted.id, 1, CAPABILITY_STAGE)).toMatchObject({
      outcome: 'advanced',
      steps: 2,
    })
    expect(await hasClearedGate(db, agentId, CAPABILITY_STAGE)).toBeNull()

    expect(await advanceChallenge(db, minted.id, 2, CAPABILITY_STAGE)).toEqual({
      outcome: 'cleared',
      agentId,
    })
    expect(await hasClearedGate(db, agentId, CAPABILITY_STAGE)).toBeTruthy()
  })

  /**
   * The step number is what makes a correct measurement non-replayable. Without
   * it in the `WHERE`, one solved step sent three times would clear the rung.
   */
  it('refuses a step that is not the one outstanding', async () => {
    const minted = await mintChallenge(db, agentId, CAPABILITY_STAGE)
    await advanceChallenge(db, minted.id, 0, CAPABILITY_STAGE)

    expect(await advanceChallenge(db, minted.id, 0, CAPABILITY_STAGE)).toEqual({
      outcome: 'out_of_order',
      steps: 1,
    })
    expect(await advanceChallenge(db, minted.id, 2, CAPABILITY_STAGE)).toEqual({
      outcome: 'out_of_order',
      steps: 1,
    })
    expect(await hasClearedGate(db, agentId, CAPABILITY_STAGE)).toBeNull()
  })

  /** Same guard as the redemption, one layer along: the `UPDATE … WHERE` is it. */
  it('lets exactly one of two concurrent reports of the same step win', async () => {
    const minted = await mintChallenge(db, agentId, CAPABILITY_STAGE)

    const results = await Promise.all([
      advanceChallenge(db, minted.id, 0, CAPABILITY_STAGE),
      advanceChallenge(db, minted.id, 0, CAPABILITY_STAGE),
    ])

    expect(results.filter((r) => r.outcome === 'advanced')).toHaveLength(1)
    expect(results.filter((r) => r.outcome === 'out_of_order')).toHaveLength(1)
  })

  it('refuses to advance an expired capability challenge', async () => {
    const minted = await mintChallenge(db, agentId, CAPABILITY_STAGE)
    await expire(minted.id)

    expect(await advanceChallenge(db, minted.id, 0, CAPABILITY_STAGE)).toEqual({
      outcome: 'expired',
    })
    expect(await challengeProgress(db, minted.id)).toEqual({ outcome: 'expired' })
  })

  it('reports progress so a reloaded page resumes rather than starting over', async () => {
    const minted = await mintChallenge(db, agentId, CAPABILITY_STAGE)
    await advanceChallenge(db, minted.id, 0, CAPABILITY_STAGE)

    expect(await challengeProgress(db, minted.id)).toEqual({
      outcome: 'open',
      // The stage is in the answer since `#160`, so a page handed an id from a
      // neighbouring stage can say so instead of drawing itself against a
      // challenge it cannot clear.
      stage: CAPABILITY_STAGE,
      steps: 1,
      total: 3,
      variant: null,
      // `null` because nothing has reported observing anything yet, which is the
      // state the reading surfaces above have to be able to tell apart from a wrong
      // answer (`#162`).
      observation: null,
    })
  })

  /**
   * The database's own backstop under the endpoint's guard. `verified_at` on a
   * capability row that has not finished its steps is the one write that would
   * make two of the three steps decoration.
   */
  it('refuses at the database to clear a capability challenge mid-sequence', async () => {
    const minted = await mintChallenge(db, agentId, CAPABILITY_STAGE)
    await advanceChallenge(db, minted.id, 0, CAPABILITY_STAGE)

    await expect(
      db
        .update(browserChallenges)
        .set({ verifiedAt: sql`now()` })
        .where(eq(browserChallenges.id, minted.id)),
    ).rejects.toThrow()
  })
})
