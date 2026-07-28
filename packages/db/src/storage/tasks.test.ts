import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { TaskSchema, type AcademyLevel, type Task, type TaskStatus } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { listTasks, type ListTasksQuery } from './tasks.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('listTasks', () => {
  let db: Database

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  interface Seed {
    readonly title?: string
    readonly level?: number
    readonly status?: TaskStatus
    /** Set explicitly where a test is about ordering rather than about content. */
    readonly createdAt?: string
  }

  const seed = async (...seeds: Seed[]): Promise<void> => {
    await db.insert(tasks).values(
      seeds.map((task, index) => ({
        type: `academy-task-${index}`,
        level: task.level ?? 0,
        title: task.title ?? `Task ${index}`,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCoins: 1,
        rewardReputation: 1,
        timeoutHours: 24,
        status: task.status ?? ('active' as const),
        ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
      })),
    )
  }

  const list = async (query: Partial<ListTasksQuery> = {}) => {
    const result = await listTasks(db, {
      maxLevel: 13,
      availableOnly: true,
      limit: 25,
      ...query,
    })
    if (result.outcome !== 'listed') throw new Error(result.outcome)
    return result.page
  }

  const titles = (items: readonly Task[]) => items.map((task) => task.title)

  it('returns the domain shape, not the row', async () => {
    await seed({})

    const { items } = await list()

    // Parsed with the core schema, so a column that drifts out of the domain
    // model fails here rather than in a foreign agent that trusted the shape.
    expect(() => items.map((task) => TaskSchema.parse(task))).not.toThrow()
    expect(items[0]?.reward).toEqual({ coins: 1, reputation: 1 })
  })

  it('is empty rather than absent when the Colony has no tasks', async () => {
    expect(await list()).toEqual({ items: [], nextCursor: null })
  })

  describe('what an agent may see', () => {
    it('hides tasks above the agent`s level', async () => {
      await seed({ title: 'Reachable', level: 1 }, { title: 'Ahead', level: 4 })

      expect(titles((await list({ maxLevel: 2 })).items)).toEqual(['Reachable'])
    })

    it('keeps levels already passed — the Academy is a ladder, not a gate', async () => {
      await seed({ title: 'Level 0', level: 0 }, { title: 'Level 2', level: 2 })

      expect(titles((await list({ maxLevel: 2 })).items)).toEqual(['Level 0', 'Level 2'])
    })

    it('narrows to one level when asked, still under the ceiling', async () => {
      await seed({ title: 'Level 0', level: 0 }, { title: 'Level 1', level: 1 })

      expect(titles((await list({ maxLevel: 3, level: 1 })).items)).toEqual(['Level 1'])
    })

    it('answers a request for a level above the ceiling with nothing', async () => {
      await seed({ title: 'Ahead', level: 5 })

      expect((await list({ maxLevel: 1, level: 5 as AcademyLevel })).items).toEqual([])
    })

    it('never shows a draft, whatever else was asked for', async () => {
      await seed({ title: 'Unfinished', status: 'draft' })

      expect((await list()).items).toEqual([])
      expect((await list({ availableOnly: false })).items).toEqual([])
    })

    it('shows a retired task only to a caller that opted out of availableOnly', async () => {
      await seed({ title: 'Live' }, { title: 'Retired', status: 'retired' })

      expect(titles((await list()).items)).toEqual(['Live'])
      expect(titles((await list({ availableOnly: false })).items).sort()).toEqual([
        'Live',
        'Retired',
      ])
    })
  })

  describe('ordering and paging', () => {
    it('climbs the Academy in order', async () => {
      await seed(
        { title: 'Third', level: 3 },
        { title: 'First', level: 0 },
        {
          title: 'Second',
          level: 1,
        },
      )

      expect(titles((await list()).items)).toEqual(['First', 'Second', 'Third'])
    })

    it('walks every task exactly once across pages', async () => {
      // Same level and the same created_at, which is the case a naive cursor
      // gets wrong: without a tiebreak the order between two rows is undefined,
      // and a page boundary that lands between them repeats one and loses the
      // other.
      const sameInstant = '2026-07-28T09:00:00.000Z'
      await seed(
        ...Array.from({ length: 7 }, (_, index) => ({
          title: `Task ${index}`,
          createdAt: sameInstant,
        })),
      )

      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0

      do {
        const page = await list({ limit: 2, cursor })
        seen.push(...titles(page.items))
        cursor = page.nextCursor
        pages += 1
        if (pages > 10) throw new Error('paging did not terminate')
      } while (cursor !== null)

      expect(seen).toHaveLength(7)
      expect(new Set(seen).size).toBe(7)
      expect(pages).toBe(4)
    })

    it('closes the walk with a null cursor, not an empty last page', async () => {
      await seed({}, {})

      const page = await list({ limit: 2 })

      expect(page.items).toHaveLength(2)
      expect(page.nextCursor).toBeNull()
    })

    it('does not repeat a row whose timestamp has sub-millisecond precision', async () => {
      // Postgres keeps microseconds; the domain's ISO timestamps keep
      // milliseconds. A cursor built from the rounded form points just *before*
      // the row it came from, and hands that row back on the next page.
      await seed({ title: 'First' }, { title: 'Second' })
      await db.execute(
        sql`update ${tasks} set created_at = timestamptz '2026-07-28 09:00:00.000001+00' where title = 'First'`,
      )
      await db.execute(
        sql`update ${tasks} set created_at = timestamptz '2026-07-28 09:00:00.000002+00' where title = 'Second'`,
      )

      const first = await list({ limit: 1 })
      const second = await list({ limit: 1, cursor: first.nextCursor })

      expect(titles(first.items)).toEqual(['First'])
      expect(titles(second.items)).toEqual(['Second'])
    })

    it('sees a task inserted mid-walk instead of shifting the ones behind it', async () => {
      // The reason the cursor is keyset and not an offset: a row arriving
      // between two pages must not push a task an agent has not read yet past
      // the boundary.
      await seed({ title: 'Task A', level: 0 }, { title: 'Task C', level: 2 })
      const first = await list({ limit: 1 })

      await seed({ title: 'Task B', level: 1 })
      const second = await list({ limit: 25, cursor: first.nextCursor })

      expect(titles(first.items)).toEqual(['Task A'])
      expect(titles(second.items)).toEqual(['Task B', 'Task C'])
    })
  })

  describe('a cursor the endpoint did not issue', () => {
    const rejected = async (cursor: string) =>
      (await listTasks(db, { maxLevel: 13, availableOnly: true, limit: 25, cursor })).outcome

    it('is refused rather than thrown, so the route can name the field', async () => {
      expect(await rejected('not-a-cursor')).toBe('invalid-cursor')
    })

    it('is refused when it decodes but carries nonsense', async () => {
      const forged = (value: string) => Buffer.from(value, 'utf8').toString('base64url')

      expect(await rejected(forged('0|2026-07-28T09:00:00Z'))).toBe('invalid-cursor')
      expect(await rejected(forged('99|2026-07-28T09:00:00Z|' + crypto.randomUUID()))).toBe(
        'invalid-cursor',
      )
      expect(await rejected(forged('0|not-a-time|' + crypto.randomUUID()))).toBe('invalid-cursor')
      expect(await rejected(forged('0|2026-07-28T09:00:00Z|not-a-uuid'))).toBe('invalid-cursor')
    })

    it('does not look addressable, so nobody hand-crafts one', async () => {
      await seed({}, {})

      const { nextCursor } = await list({ limit: 1 })

      expect(nextCursor).not.toBeNull()
      expect(nextCursor).not.toContain('level')
      expect(nextCursor).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    })
  })
})
