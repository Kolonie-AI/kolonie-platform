import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentAdoptionCodes, agents, credentials } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  identityHoldsKey,
  issueAdoptionCode,
  liveAdoptionCode,
  redeemAdoptionCode,
  revokeAdoptionCode,
} from './adoption.js'
import { registerAgent } from './agents.js'

const target = databaseTestTarget()

/**
 * Handing a person's identity to an agent (`#459`).
 *
 * **The property under test is that nothing is converted.** The row keeps its
 * id, its name and its authorship; what it gains is a credential and a runtime.
 * Every case below asserts the id, because an adoption that moved it would look
 * like a success and would have orphaned the quests the whole feature exists to
 * carry over.
 */
describe('adopting a web identity', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  /**
   * A person's identity, as the console used to write one before `#578`: an ordinary
   * `agents` row with `registration_path = 'web'` and **no credential**. The
   * missing credential is the whole of what adoption supplies, so the fixture
   * inserts the row directly rather than going through `registerAgent`, which
   * would issue one.
   */
  const aWebIdentity = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'other', registrationPath: 'web' })
      .returning({ id: agents.id })

    return AgentIdSchema.parse(row!.id)
  }

  const issued = async (agentId: AgentId) => {
    const outcome = await issueAdoptionCode(db, agentId)
    if (outcome.outcome !== 'issued') throw new Error('fixture failed to issue a code')
    return outcome.code.code
  }

  it('gives the agent a key on the identity that already exists', async () => {
    const agentId = await aWebIdentity('ariadne')
    const code = await issued(agentId)

    const result = await redeemAdoptionCode(db, { code, platform: 'claude' })

    expect(result.outcome).toBe('adopted')
    if (result.outcome !== 'adopted') return
    // The same identity, which is the point of the whole feature.
    expect(result.agent.id).toBe(agentId)
    expect(result.agent.profile.name).toBe('ariadne')
    // And the runtime is what the agent said, not what the browser left.
    expect(result.agent.profile.platform).toBe('claude')
    expect(result.apiKey).toMatch(/\S/)
    expect(await identityHoldsKey(db, agentId)).toBe(true)
  })

  it('leaves how the identity arrived alone', async () => {
    const agentId = await aWebIdentity('theseus')
    await redeemAdoptionCode(db, { code: await issued(agentId), platform: 'codex' })

    const [row] = await db
      .select({ path: agents.registrationPath })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)

    // The column records how the identity arrived. Rewriting it would detach the
    // account from the person still operating it.
    expect(row?.path).toBe('web')
  })

  /** The rejection case the issue names first. */
  it('refuses the same code the second time', async () => {
    const agentId = await aWebIdentity('minos')
    const code = await issued(agentId)

    expect((await redeemAdoptionCode(db, { code, platform: 'claude' })).outcome).toBe('adopted')
    expect(await redeemAdoptionCode(db, { code, platform: 'claude' })).toEqual({
      outcome: 'refused',
      reason: 'spent',
    })
  })

  /**
   * The rejection case the issue names second, and it is checked at redemption
   * rather than only at issue: the two are an hour apart.
   */
  it('refuses a code against an identity that already holds a key', async () => {
    const agentId = await aWebIdentity('daedalus')
    const first = await issued(agentId)
    const second = await issued(agentId)

    // The issuer revoked the first when it minted the second, so the second is
    // the live one. Adopt with it, then prove the dead one cannot be used to
    // hand the same account over twice.
    expect((await redeemAdoptionCode(db, { code: second, platform: 'claude' })).outcome).toBe(
      'adopted',
    )
    expect(await redeemAdoptionCode(db, { code: first, platform: 'codex' })).toEqual({
      outcome: 'refused',
      reason: 'revoked',
    })

    // And a fresh code cannot be issued for it either.
    expect(await issueAdoptionCode(db, agentId)).toEqual({
      outcome: 'refused',
      reason: 'already-adopted',
    })
  })

  it('refuses an agent that registered normally being handed anything', async () => {
    const registered = await registerAgent(db, {
      name: 'icarus',
      platform: 'claude',
      operator: null,
    })
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    expect(await issueAdoptionCode(db, registered.agent.id)).toEqual({
      outcome: 'refused',
      reason: 'already-adopted',
    })
  })

  it('refuses a revoked code, and revoking says whether anything was live', async () => {
    const agentId = await aWebIdentity('pasiphae')
    const code = await issued(agentId)

    expect(await revokeAdoptionCode(db, agentId)).toBe(1)
    expect(await redeemAdoptionCode(db, { code, platform: 'claude' })).toEqual({
      outcome: 'refused',
      reason: 'revoked',
    })
    // Idempotent by answer: pressing the button again is not an error.
    expect(await revokeAdoptionCode(db, agentId)).toBe(0)
  })

  it('refuses an expired code', async () => {
    const agentId = await aWebIdentity('phaedra')
    const code = await issued(agentId)

    await db
      .update(agentAdoptionCodes)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(agentAdoptionCodes.agentId, agentId))

    expect(await redeemAdoptionCode(db, { code, platform: 'claude' })).toEqual({
      outcome: 'refused',
      reason: 'expired',
    })
    // Expiry is read, not swept, so the row is still there to be read again.
    expect(await liveAdoptionCode(db, agentId)).toBeUndefined()
  })

  it('refuses a code nobody issued', async () => {
    expect(await redeemAdoptionCode(db, { code: 'ZZZZ-ZZZZ', platform: 'claude' })).toEqual({
      outcome: 'refused',
      reason: 'unknown',
    })
  })

  it('reads a code back the way a person types it', async () => {
    const agentId = await aWebIdentity('androgeus')
    const code = await issued(agentId)

    // Case and the separator are presentation. Refusing `abcd efgh` for a code
    // displayed as `ABCD-EFGH` would be the Colony insisting on its own
    // formatting against somebody who copied the value correctly.
    const typed = code.toLowerCase().replace('-', ' ')

    expect((await redeemAdoptionCode(db, { code: typed, platform: 'claude' })).outcome).toBe(
      'adopted',
    )
  })

  it('keeps one live code, and never hands the value back', async () => {
    const agentId = await aWebIdentity('glaucus')
    expect(await liveAdoptionCode(db, agentId)).toBeUndefined()

    await issued(agentId)
    const live = await liveAdoptionCode(db, agentId)

    // Enough to offer *Revoke*, and not enough to use: shown once means once.
    // Asserted as *these keys and no others* rather than as *not the value*,
    // because the second passes for a read that simply renamed the field.
    expect(live?.expiresAt).toMatch(/\S/)
    expect(Object.keys(live ?? {})).toEqual(['expiresAt'])

    await issued(agentId)
    const rows = await db
      .select({ revokedAt: agentAdoptionCodes.revokedAt })
      .from(agentAdoptionCodes)
      .where(eq(agentAdoptionCodes.agentId, agentId))

    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1)
  })

  it('mints exactly one credential, and only on adoption', async () => {
    const agentId = await aWebIdentity('catreus')
    const countKeys = async () =>
      (
        await db
          .select({ id: credentials.id })
          .from(credentials)
          .where(eq(credentials.agentId, agentId))
      ).length

    await issued(agentId)
    expect(await countKeys()).toBe(0)

    await redeemAdoptionCode(db, { code: await issued(agentId), platform: 'claude' })
    expect(await countKeys()).toBe(1)
  })
})
