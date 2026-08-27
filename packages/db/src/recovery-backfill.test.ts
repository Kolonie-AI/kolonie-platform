import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { accounts, keyChallenges } from './schema/index.js'
import { registerAgent } from './storage/agents.js'
import { connectForTests, databaseTestTarget, MIGRATIONS_FOLDER, truncateAll } from './testing.js'

const target = databaseTestTarget()
const MIGRATION = '0346_typical_bill_hollister.sql'

describe('the recovery keypair-account backfill', () => {
  let db: Database
  let statements: string[]
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
    const file = await readFile(join(MIGRATIONS_FOLDER, MIGRATION), 'utf8')
    statements = file
      .slice(file.indexOf('UPDATE "accounts"'))
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'historic-signer', platform: 'openclaw' }),
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)
    agentId = registered.agent.id
  })

  const verifiedKey = async (publicKey: string) => {
    await db.insert(keyChallenges).values({
      agentId,
      nonce: `nonce-${publicKey}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      algorithm: 'ed25519',
      publicKey,
      signature: 'verified signature',
      verifiedAt: new Date().toISOString(),
    })
  }

  const backfill = async () => {
    for (const statement of statements) await db.execute(sql.raw(statement))
  }

  it('records a proved signing account for an earlier key-signature pass', async () => {
    await verifiedKey('historic-public-key')

    await backfill()

    expect(await db.select().from(accounts).where(eq(accounts.agentId, agentId))).toMatchObject([
      {
        kind: 'keypair',
        identifier: 'historic-public-key',
        proved: true,
        provedBy: 'rung',
        capabilities: ['sign'],
      },
    ])
  })

  it('upgrades an existing declaration instead of leaving it unproved', async () => {
    await db.insert(accounts).values({
      agentId,
      kind: 'keypair',
      identifier: 'declared-public-key',
    })
    await verifiedKey('declared-public-key')

    await backfill()
    await backfill()

    expect(await db.select().from(accounts).where(eq(accounts.agentId, agentId))).toMatchObject([
      {
        identifier: 'declared-public-key',
        proved: true,
        provedBy: 'rung',
        capabilities: ['sign'],
      },
    ])
  })

  it('does not turn an unanswered challenge into an account', async () => {
    await db.insert(keyChallenges).values({
      agentId,
      nonce: 'open-challenge',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    await backfill()

    expect(await db.select().from(accounts).where(eq(accounts.agentId, agentId))).toEqual([])
  })
})
