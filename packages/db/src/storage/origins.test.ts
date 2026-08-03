import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentOrigins } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { recentOrigins, recordOrigin, type ObservedOrigin } from './origins.js'

const target = databaseTestTarget()

/** A digest-shaped value. Never an address, which is the point of the column. */
const digest = (seed: string) => seed.repeat(64).slice(0, 64)

const FRANKFURT: ObservedOrigin = {
  fingerprint: digest('a'),
  country: 'DE',
  colo: 'FRA',
}

/**
 * The origins the Colony observed (`#191`): what it read off a request, as
 * opposed to what a citizen said about itself.
 */
describe('observed origins', () => {
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

  const anAgent = async (name = 'canary'): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const rowsFor = async (agentId: AgentId) =>
    await db.select().from(agentOrigins).where(eq(agentOrigins.agentId, agentId))

  it('records the first call from a place, with the count at one', async () => {
    const agentId = await anAgent()

    expect(await recordOrigin(db, agentId, FRANKFURT)).toBe('observed')

    const [row] = await rowsFor(agentId)
    expect(row?.fingerprint).toBe(FRANKFURT.fingerprint)
    expect(row?.country).toBe('DE')
    expect(row?.colo).toBe('FRA')
    expect(row?.calls).toBe(1)
  })

  /**
   * The whole reason the table is deduplicated: a citizen that calls a thousand
   * times from one machine is one row and a counter, never a thousand rows.
   * Anything else would be a per-request location trace, which is a much larger
   * and much worse thing than what this issue asked for.
   */
  it('counts a repeat call rather than writing a second row', async () => {
    const agentId = await anAgent()

    await recordOrigin(db, agentId, FRANKFURT)
    expect(await recordOrigin(db, agentId, FRANKFURT)).toBe('seen-again')
    await recordOrigin(db, agentId, FRANKFURT)

    const rows = await rowsFor(agentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.calls).toBe(3)
  })

  /** The rejection case the definition of done names, stated as a schema property. */
  it('refuses a second row for the same citizen and fingerprint', async () => {
    const agentId = await anAgent()
    await recordOrigin(db, agentId, FRANKFURT)

    // Straight at the table, bypassing the upsert: the uniqueness is the
    // index's promise and not the writer's politeness.
    await expect(
      db.insert(agentOrigins).values({ agentId, fingerprint: FRANKFURT.fingerprint }),
    ).rejects.toThrow()
  })

  it('keeps a second place as a second row', async () => {
    const agentId = await anAgent()

    await recordOrigin(db, agentId, FRANKFURT)
    await recordOrigin(db, agentId, { fingerprint: digest('b'), country: 'NL', colo: 'AMS' })

    expect(await rowsFor(agentId)).toHaveLength(2)
  })

  it('keeps one citizen’s origins out of another’s', async () => {
    const mine = await anAgent('canary-one')
    const theirs = await anAgent('canary-two')

    await recordOrigin(db, mine, FRANKFURT)

    expect(await recentOrigins(db, theirs)).toEqual([])
  })

  it('leaves first_seen_at alone and moves last_seen_at', async () => {
    const agentId = await anAgent()
    await recordOrigin(db, agentId, FRANKFURT)
    const [first] = await rowsFor(agentId)

    // A gap the timestamp can actually resolve, without waiting for one.
    await db
      .update(agentOrigins)
      .set({ lastSeenAt: sql`now() - interval '1 hour'` })
      .where(eq(agentOrigins.agentId, agentId))
    await recordOrigin(db, agentId, FRANKFURT)

    const [again] = await rowsFor(agentId)
    expect(again?.firstSeenAt).toBe(first?.firstSeenAt)
    expect(Date.parse(again!.lastSeenAt)).toBeGreaterThan(Date.parse(first!.firstSeenAt) - 1)
    expect(again?.calls).toBe(2)
  })

  /**
   * **A local run writes a row with nulls rather than no row.** *The Colony saw
   * you and could not tell from where* is a true thing to have recorded, and
   * writing nothing would make the table look like a feature that does not work
   * rather than an edge that is not in front of it.
   */
  it('records an origin with no geography at all', async () => {
    const agentId = await anAgent()

    expect(
      await recordOrigin(db, agentId, { fingerprint: digest('c'), country: null, colo: null }),
    ).toBe('observed')

    const [row] = await rowsFor(agentId)
    expect(row?.country).toBeNull()
    expect(row?.colo).toBeNull()
  })

  /**
   * The direction that matters: a later call arriving without an edge in front
   * of it must not erase geography an earlier call through Cloudflare
   * established. Treating null as a value would mean one local request wiped a
   * production row.
   */
  it('fills in geography a later call learns, and never erases it', async () => {
    const agentId = await anAgent()

    await recordOrigin(db, agentId, { fingerprint: digest('a'), country: null, colo: null })
    await recordOrigin(db, agentId, FRANKFURT)
    await recordOrigin(db, agentId, { fingerprint: digest('a'), country: null, colo: null })

    const [row] = await rowsFor(agentId)
    expect(row?.country).toBe('DE')
    expect(row?.colo).toBe('FRA')
    expect(row?.calls).toBe(3)
  })

  it('hands the citizen its own origins, newest first', async () => {
    const agentId = await anAgent()
    await recordOrigin(db, agentId, FRANKFURT)
    await db
      .update(agentOrigins)
      .set({ lastSeenAt: sql`now() - interval '1 day'` })
      .where(eq(agentOrigins.agentId, agentId))
    await recordOrigin(db, agentId, { fingerprint: digest('b'), country: 'NL', colo: 'AMS' })

    const origins = await recentOrigins(db, agentId)

    expect(origins.map((origin) => origin.country)).toEqual(['NL', 'DE'])
    // The digest is handed back rather than withheld: withholding it would
    // protect nothing and would make a citizen's own record less legible to it
    // than to the Colony.
    expect(origins[1]?.fingerprint).toBe(FRANKFURT.fingerprint)
    // Null until `kolonie-infra#63` lands, which is that issue being open
    // rather than a defect in this one.
    expect(origins[0]?.asn).toBeNull()
    expect(origins[0]?.city).toBeNull()
  })

  it('bounds what it hands back', async () => {
    const agentId = await anAgent()
    for (let index = 0; index < 5; index += 1) {
      await recordOrigin(db, agentId, {
        fingerprint: digest(String(index)),
        country: null,
        colo: null,
      })
    }

    expect(await recentOrigins(db, agentId, 3)).toHaveLength(3)
  })

  /**
   * **It never fails the request.** This rides on the authentication path, which
   * every authenticated call goes through; instrumentation that can stand
   * between a citizen and its rung is worse than no instrumentation.
   */
  it('answers rather than throwing when the row cannot be written', async () => {
    const absent = '11111111-2222-4333-8444-555555555555' as AgentId

    expect(await recordOrigin(db, absent, FRANKFURT)).toBe('failed')
  })
})

/**
 * **Nothing decides on an origin**, asserted mechanically rather than by reading
 * the diff — the same technique `sessions.test.ts` uses, for the same reason.
 *
 * The rule is about the whole storage layer and cannot be checked by exercising
 * one code path: the way it breaks is that somebody adds a reasonable-looking
 * rate limit keyed on a fingerprint two years from now. So this reads the
 * source, and a file arriving in the list is not necessarily wrong — it has to
 * be argued for and added below, which is the point.
 */
describe('nothing decides on an origin', () => {
  const ALLOWED = new Set(['origins.ts', 'origins.test.ts'])

  it('is referenced by no storage module that decides anything', async () => {
    const storage = fileURLToPath(new URL('.', import.meta.url))
    const files = await readdir(storage)

    const offenders: string[] = []
    for (const file of files) {
      if (!file.endsWith('.ts') || ALLOWED.has(file)) continue

      const source = await readFile(`${storage}${file}`, 'utf8')
      if (/agentOrigins|agent_origins/.test(source)) offenders.push(file)
    }

    expect(offenders).toEqual([])
  })
})
