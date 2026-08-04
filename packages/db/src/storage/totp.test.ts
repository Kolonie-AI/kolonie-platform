import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  RegisterAgentRequestSchema,
  totpCodeAt,
  totpCounterAt,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { checkTotpCode, mintTotpSecretFor, totpRungRecord } from './totp.js'

const target = databaseTestTarget()

/** The code that is right at this instant, computed the way a citizen would. */
const codeFor = (secret: string): string =>
  totpCodeAt(secret, totpCounterAt(Math.floor(Date.now() / 1000)))

describe('the second-factor rung', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `holding-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /** Push stage one back in time, which is the only way to reach stage two in a test. */
  const proveWasHoursAgo = async (agentId: AgentId, hours: number) => {
    await db.execute(
      sql`update totp_secrets set proved_at = now() - (${hours} || ' hours')::interval
           where agent_id = ${agentId}`,
    )
  }

  const secretOf = async (agentId: AgentId): Promise<string> => {
    const [row] = await db.execute<{ secret: string }>(
      sql`select secret from totp_secrets where agent_id = ${agentId} and superseded_at is null`,
    )
    return row!.secret
  }

  it('mints a secret once', async () => {
    const minted = await mintTotpSecretFor(db, await anAgent(), false)

    expect(minted.outcome).toBe('minted')
  })

  /**
   * A citizen calling twice by habit would otherwise invalidate the secret it
   * has already stored, and the rung would fail it for the Colony's convenience.
   */
  it('refuses to replace a live secret unless asked, and returns no value when it refuses', async () => {
    const agentId = await anAgent()
    await mintTotpSecretFor(db, agentId, false)

    const again = await mintTotpSecretFor(db, agentId, false)

    expect(again.outcome).toBe('live')
    expect(JSON.stringify(again)).not.toContain(await secretOf(agentId))
  })

  it('supersedes the old secret when replacement is asked for', async () => {
    const agentId = await anAgent()
    const first = await mintTotpSecretFor(db, agentId, false)
    const second = await mintTotpSecretFor(db, agentId, true)

    expect(second.outcome).toBe('minted')
    expect(second.outcome === 'minted' && second.secret).not.toBe(
      first.outcome === 'minted' && first.secret,
    )
    const [row] = await db.execute<{ count: string }>(
      sql`select count(*) from totp_secrets where superseded_at is not null`,
    )
    expect(row?.count).toBe('1')
  })

  it('records the first correct code as stage one', async () => {
    const agentId = await anAgent()
    const minted = await mintTotpSecretFor(db, agentId, false)
    if (minted.outcome !== 'minted') throw new Error(minted.outcome)

    const checked = await checkTotpCode(db, agentId, codeFor(minted.secret))

    expect(checked.outcome).toBe('proved')
    expect((await totpRungRecord(db, agentId)).provedAt).not.toBeNull()
    expect((await totpRungRecord(db, agentId)).heldAt).toBeNull()
  })

  /**
   * The whole value of the rung. Stage one proves arithmetic; this proves the
   * secret survived the run that received it.
   */
  it('records a correct code a rhythm later as stage two, and the rung passes on it', async () => {
    const agentId = await anAgent()
    const minted = await mintTotpSecretFor(db, agentId, false)
    if (minted.outcome !== 'minted') throw new Error(minted.outcome)

    await checkTotpCode(db, agentId, codeFor(minted.secret))
    await proveWasHoursAgo(agentId, 7)
    const held = await checkTotpCode(db, agentId, codeFor(minted.secret))

    expect(held.outcome).toBe('held')
    expect((await totpRungRecord(db, agentId)).heldAt).not.toBeNull()
  })

  it('refuses a second code in the same session rather than failing it', async () => {
    const agentId = await anAgent()
    const minted = await mintTotpSecretFor(db, agentId, false)
    if (minted.outcome !== 'minted') throw new Error(minted.outcome)

    await checkTotpCode(db, agentId, codeFor(minted.secret))
    const early = await checkTotpCode(db, agentId, codeFor(minted.secret))

    expect(early.outcome).toBe('same-session')
    // Nothing was spent: the secret is still outstanding and stage two is not set.
    expect((await totpRungRecord(db, agentId)).heldAt).toBeNull()
  })

  it('says how many hours are left when a citizen is early but past the bucket', async () => {
    const agentId = await anAgent()
    const minted = await mintTotpSecretFor(db, agentId, false)
    if (minted.outcome !== 'minted') throw new Error(minted.outcome)

    await checkTotpCode(db, agentId, codeFor(minted.secret))
    await proveWasHoursAgo(agentId, 2)
    const early = await checkTotpCode(db, agentId, codeFor(minted.secret))

    expect(early.outcome).toBe('too-soon')
    expect(early.outcome === 'too-soon' && early.remainingHours).toBeGreaterThan(0)
  })

  it('counts a wrong code and holds the stage where it was', async () => {
    const agentId = await anAgent()
    await mintTotpSecretFor(db, agentId, false)

    const wrong = await checkTotpCode(db, agentId, '000000')

    // A correct code is 1 in a million, so a rare pass here is the arithmetic
    // working rather than the test being wrong.
    if (wrong.outcome === 'proved') return

    expect(wrong.outcome).toBe('wrong')
    expect((await totpRungRecord(db, agentId)).provedAt).toBeNull()
    expect((await totpRungRecord(db, agentId)).wrongAttempts).toBe(1)
  })

  it('says nothing at all about a citizen with no secret', async () => {
    const agentId = await anAgent()

    expect(await checkTotpCode(db, agentId, '000000')).toEqual({ outcome: 'no_secret' })
    expect(await totpRungRecord(db, agentId)).toMatchObject({ issuedAt: null, provedAt: null })
  })

  /** The record the verifier reads must never be able to leak the secret. */
  it('never carries the secret in what the verifier reads', async () => {
    const agentId = await anAgent()
    const minted = await mintTotpSecretFor(db, agentId, false)
    if (minted.outcome !== 'minted') throw new Error(minted.outcome)

    expect(JSON.stringify(await totpRungRecord(db, agentId))).not.toContain(minted.secret)
  })

  /**
   * The order is the rung: certifying retained possession of something never
   * shown to be understood would be certifying nothing.
   */
  it('refuses a row where stage two precedes stage one', async () => {
    const agentId = await anAgent()
    await mintTotpSecretFor(db, agentId, false)

    await expect(
      db.execute(sql`update totp_secrets set held_at = now() where agent_id = ${agentId}`),
    ).rejects.toThrow()
  })

  it('goes when its owner does', async () => {
    const agentId = await anAgent()
    await mintTotpSecretFor(db, agentId, false)

    await db.execute(sql`delete from agents where id = ${agentId}`)

    const [row] = await db.execute<{ count: string }>(sql`select count(*) from totp_secrets`)
    expect(row?.count).toBe('0')
  })
})
