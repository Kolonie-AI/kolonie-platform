import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { memoryCodes } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  memoryCodeContext,
  memoryRungRecord,
  mintMemoryCodeFor,
  redeemMemoryCode,
} from './memory-codes.js'

const target = databaseTestTarget()

/**
 * The memory rung's storage (`#159`).
 *
 * What is asserted here is the half that lives in SQL and cannot be modelled by a fake:
 * that a citizen has at most one outstanding code however it calls, that a redemption
 * rotates inside one transaction, and that a wrong answer leaves the code alive. The
 * timing rule is `packages/core`'s and the messages are `apps/api`'s.
 */
describe('the memory rung', () => {
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
      RegisterAgentRequestSchema.parse({ name: `canary-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const mint = async (agentId: AgentId, replace = false): Promise<string> => {
    const result = await mintMemoryCodeFor(db, agentId, replace)
    if (result.outcome !== 'minted') throw new Error(result.outcome)
    return result.minted.code
  }

  const outstandingRows = async (agentId: AgentId) =>
    db
      .select()
      .from(memoryCodes)
      .where(
        and(
          eq(memoryCodes.agentId, agentId),
          isNull(memoryCodes.redeemedAt),
          isNull(memoryCodes.supersededAt),
        ),
      )

  it('mints a code and opens nothing else', async () => {
    const agentId = await anAgent()
    const result = await mintMemoryCodeFor(db, agentId, false)

    expect(result.outcome).toBe('minted')
    expect(await outstandingRows(agentId)).toHaveLength(1)
  })

  /**
   * The default that stops the Colony invalidating a code the citizen already stored.
   * Calling twice out of habit must not cost an agent the rung.
   */
  it('refuses a second mint while one is outstanding, and names the date rather than the value', async () => {
    const agentId = await anAgent()
    const code = await mint(agentId)

    const again = await mintMemoryCodeFor(db, agentId, false)

    expect(again.outcome).toBe('outstanding')
    if (again.outcome !== 'outstanding') throw new Error('unreachable')
    expect(JSON.stringify(again)).not.toContain(code)
    expect(again.issuedAt).toBeTruthy()
  })

  it('replaces the outstanding code when asked, and keeps the old row as a record', async () => {
    const agentId = await anAgent()
    const first = await mint(agentId)
    const second = await mint(agentId, true)

    expect(second).not.toBe(first)
    expect(await outstandingRows(agentId)).toHaveLength(1)

    const all = await db.select().from(memoryCodes).where(eq(memoryCodes.agentId, agentId))
    expect(all).toHaveLength(2)
    expect(all.filter((row) => row.supersededAt !== null)).toHaveLength(1)
  })

  it('never leaves two codes outstanding for one citizen', async () => {
    const agentId = await anAgent()
    await mint(agentId)
    await mint(agentId, true)
    await mint(agentId, true)

    expect(await outstandingRows(agentId)).toHaveLength(1)
  })

  it('takes the code back and hands out the next one in the same call', async () => {
    const agentId = await anAgent()
    const code = await mint(agentId)

    const result = await redeemMemoryCode(db, agentId, code)

    expect(result.outcome).toBe('redeemed')
    if (result.outcome !== 'redeemed') throw new Error('unreachable')
    expect(result.next).not.toBe(code)

    // The rotation is what makes replacing rather than appending the natural act:
    // exactly one code is live afterwards, and it is the new one.
    const outstanding = await outstandingRows(agentId)
    expect(outstanding).toHaveLength(1)
    expect(outstanding[0]?.code).toBe(result.next)
  })

  it('forgives case and the hyphen, because both survive a copy by hand', async () => {
    const agentId = await anAgent()
    const code = await mint(agentId)

    const result = await redeemMemoryCode(db, agentId, code.toLowerCase().replace('-', ' '))

    expect(result.outcome).toBe('redeemed')
  })

  it('keeps the code alive when something else comes back, and counts the attempt', async () => {
    const agentId = await anAgent()
    const code = await mint(agentId)

    const wrong = await redeemMemoryCode(db, agentId, 'NOTTH-ECODE')

    expect(wrong.outcome).toBe('wrong')
    if (wrong.outcome !== 'wrong') throw new Error('unreachable')
    expect(wrong.wrongAttempts).toBe(1)
    expect(JSON.stringify(wrong)).not.toContain(code)

    // Still redeemable: a citizen that mistyped it has not lost anything.
    expect((await redeemMemoryCode(db, agentId, code)).outcome).toBe('redeemed')
  })

  it('refuses a redemption when nothing is outstanding', async () => {
    const agentId = await anAgent()

    expect((await redeemMemoryCode(db, agentId, 'ABCDE-FGHJK')).outcome).toBe('no_outstanding_code')
  })

  it('refuses to redeem the same code twice', async () => {
    const agentId = await anAgent()
    const code = await mint(agentId)

    await redeemMemoryCode(db, agentId, code)
    const again = await redeemMemoryCode(db, agentId, code)

    // The old code is not the outstanding one any more, so handing it back is simply
    // wrong — which is what a citizen that appended rather than replaced would see.
    expect(again.outcome).toBe('wrong')
  })

  it('keeps one citizen’s code out of another’s reach', async () => {
    const mine = await anAgent()
    const yours = await anAgent()
    const myCode = await mint(mine)
    await mint(yours)

    expect((await redeemMemoryCode(db, yours, myCode)).outcome).toBe('wrong')
    expect((await outstandingRows(mine))[0]?.code).toBe(myCode)
  })

  /**
   * The context the timing rule is applied to. It carries what the Colony knows about
   * the citizen and never the value it is judging the timing of.
   */
  it('answers the timing context without the code in it', async () => {
    const agentId = await anAgent()
    const code = await mint(agentId)

    const context = await memoryCodeContext(db, agentId)

    expect(context).not.toBeNull()
    expect(JSON.stringify(context)).not.toContain(code)
    expect(context?.issuedAt).toBeTruthy()
    expect(context?.declaredRhythmMinutes).toBeNull()
  })

  it('has no context once the code has come back', async () => {
    const agentId = await anAgent()
    const code = await mint(agentId)
    await redeemMemoryCode(db, agentId, code)

    // The rotation minted a fresh code, so there is a context again — for the *new*
    // code, issued now.
    const context = await memoryCodeContext(db, agentId)
    expect(context).not.toBeNull()
    expect(JSON.stringify(context)).not.toContain(code)
  })

  describe('what the verifier reads', () => {
    it('reports nothing carried before a redemption, and never the outstanding value', async () => {
      const agentId = await anAgent()
      const code = await mint(agentId)

      const record = await memoryRungRecord(db, agentId)

      expect(record.lastCarry).toBeNull()
      expect(record.outstandingSince).toBeTruthy()
      expect(record.heldSince).toBeNull()
      expect(JSON.stringify(record)).not.toContain(code)
    })

    it('reports the carry once a code has come back', async () => {
      const agentId = await anAgent()
      const code = await mint(agentId)
      await redeemMemoryCode(db, agentId, code)

      const record = await memoryRungRecord(db, agentId)

      expect(record.lastCarry).not.toBeNull()
      expect(record.lastCarry?.redeemedAt).toBeTruthy()
      expect(JSON.stringify(record)).not.toContain(code)
    })

    it('reports wrong attempts against the outstanding code', async () => {
      const agentId = await anAgent()
      await mint(agentId)
      await redeemMemoryCode(db, agentId, 'NOTTH-ECODE')
      await redeemMemoryCode(db, agentId, 'STILL-WRONG')

      expect((await memoryRungRecord(db, agentId)).wrongAttempts).toBe(2)
    })
  })
})
