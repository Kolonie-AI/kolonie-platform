import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import { type Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  createDefaultBoard,
  recallWorkplace,
  rebuildWorkplaceRecallProjection,
} from './workplace.js'
import { agents } from '../schema/index.js'

const target = databaseTestTarget()

/**
 * Benchmark required by #1943:
 * 100,000 visible card/closure result rows, 10 warmups, 100 sequential fixed
 * queries, p95 <= 500ms, and no unauthorized row fetched into memory.
 */
describe('workplace recall 100k benchmark (#1943)', () => {
  let db: Database
  let owner: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  it('meets p95 <= 500ms over 100,000 visible rows with 10 warmups and 100 queries', async () => {
    await truncateAll(db)
    const registered = await registerAgent(db, {
      name: 'bench-owner',
      platform: 'openclaw',
      operator: null,
    })
    if (registered.outcome !== 'registered') throw new Error('registration failed')
    owner = registered.agent.id
    await db
      .update(agents)
      .set({ status: 'citizen' })
      .where(sql`id = ${owner}`)
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Benchmark Board' })

    // Generate 50,000 cards + 50,000 closures = 100,000 visible rows
    await db.execute(sql`
      WITH inserted_cards AS (
        INSERT INTO workplace_cards (board_id, status, kind, title, description, outcome, position, created_at, updated_at)
        SELECT
          ${board.id},
          'done',
          'action',
          'Benchmark card ' || i || ' telemetry experiment ' || (i % 50),
          'Detailed description covering lunar navigation parameter ' || (i % 100),
          'Benchmark outcome ' || i,
          1000 + i,
          now() - (i || ' minutes')::interval,
          now() - (i || ' minutes')::interval
        FROM generate_series(1, 50000) AS i
        RETURNING id, board_id, created_at
      )
      INSERT INTO workplace_card_closures (board_id, card_id, revision, result, summary, learned, next, legacy, created_at)
      SELECT
        c.board_id,
        c.id,
        1,
        CASE WHEN (row_number() OVER ()) % 2 = 0 THEN 'shipped' ELSE 'failed_experiment' END,
        'Closure outcome report ' || (row_number() OVER ()),
        'Learned that lunar telemetry requires bounded intervals',
        '{"kind":"none"}'::jsonb,
        false,
        c.created_at
      FROM inserted_cards c;
    `)

    await rebuildWorkplaceRecallProjection(db)
    await db.execute(sql`ANALYZE workplace_cards; ANALYZE workplace_card_closures;`)

    const queries = [
      'lunar',
      'telemetry',
      'experiment',
      'navigation',
      'parameter',
      'bounded',
      'intervals',
      'outcome',
      'report',
      'detailed',
    ]

    // 10 warmups
    for (let i = 0; i < 10; i++) {
      await recallWorkplace(db, owner, {
        query: queries[i % queries.length]!,
        scope: 'my_default',
        limit: 10,
      })
    }

    // 100 sequential queries
    const timings: number[] = []
    for (let i = 0; i < 100; i++) {
      const q = queries[i % queries.length]!
      const start = performance.now()
      const result = await recallWorkplace(db, owner, {
        query: q,
        scope: 'my_default',
        limit: 10,
      })
      const duration = performance.now() - start
      timings.push(duration)
      expect(result.outcome).toBe('recalled')
      if (result.outcome === 'recalled') {
        expect(result.items.length).toBeGreaterThan(0)
      }
    }

    timings.sort((a, b) => a - b)
    const p50 = timings[Math.floor(timings.length * 0.5)]!
    const p95 = timings[Math.floor(timings.length * 0.95)]!
    const p99 = timings[Math.floor(timings.length * 0.99)]!
    const max = timings[timings.length - 1]!

    console.log(
      `[workplace recall benchmark] 100k rows: p50=${p50.toFixed(2)}ms, p95=${p95.toFixed(2)}ms, p99=${p99.toFixed(2)}ms, max=${max.toFixed(2)}ms`,
    )
    expect(p95).toBeLessThanOrEqual(500)
  }, 180000)
})
