import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  WorkplaceCardIdSchema,
  WorkplaceLinkIdSchema,
  type AgentId,
  type WorkplaceLinkId,
  type WorkplaceStructuredCardClosureRequest,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  addLink,
  claimCard,
  completeCard,
  createCard,
  createCardClosure,
  createDefaultBoard,
} from './workplace.js'
import { workplaceOutcomeMetrics } from './workplace-outcomes.js'

const target = databaseTestTarget()

/**
 * Outcome telemetry for ordinary-card closures (`#1944`).
 *
 * The privacy argument is the shape of the table — five columns, none of which
 * names a citizen, board, card or closure — and the schema assertions below are
 * what keeps that argument true after this file was written. The behavioural
 * tests then hold the two promises the aggregation makes: one event per
 * structured closure transaction, and corrections counted as revisions rather
 * than as new shipments.
 */
describe('workplace outcome telemetry', () => {
  let db: Database
  let owner: AgentId
  let boardId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    owner = await citizen('owner')
    const board = await createDefaultBoard(db, { callerId: owner, title: 'Default board' })
    boardId = board.id
  })

  const citizen = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (registered.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return registered.agent.id
  }

  const closedCard = async (
    result: 'shipped' | 'failed_experiment' | 'abandoned' | 'superseded',
    evidence: boolean,
    title: string,
    options?: { readonly successorCardId?: string },
  ) => {
    const created = await createCard(db, {
      callerId: owner,
      boardId,
      title,
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const evidenceLinkIds: WorkplaceLinkId[] = []
    if (evidence) {
      const link = await addLink(db, {
        callerId: owner,
        cardId: created.card.id,
        kind: 'url',
        ref: 'https://example.com/outcome',
      })
      if (link.outcome !== 'created') throw new Error('link missing')
      evidenceLinkIds.push(link.link.id)
    }
    const summary =
      result === 'failed_experiment' && evidenceLinkIds.length === 0
        ? `Tried ${title} and observed status 500.`
        : `Closed ${title}.`
    const common = {
      summary,
      learned: 'The outcome is recorded.',
      evidenceLinkIds,
    }
    let close: WorkplaceStructuredCardClosureRequest
    if (result === 'superseded') {
      close = {
        ...common,
        result,
        next: {
          kind: 'card',
          cardId: WorkplaceCardIdSchema.parse(options?.successorCardId ?? created.card.id),
        },
      }
    } else if (result === 'abandoned') {
      close = { ...common, result, next: { kind: 'sentence', text: 'Stopped this approach.' } }
    } else if (result === 'failed_experiment') {
      close = { ...common, result, next: { kind: 'none' } }
    } else {
      close = { ...common, result, next: { kind: 'none' } }
    }
    const completed = await completeCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: claimed.card.version,
      close,
    })
    if (completed.outcome !== 'completed')
      throw new Error(`completion failed: ${JSON.stringify(completed)}`)
    return completed
  }

  it('writes exactly one anonymised event per structured closure transaction', async () => {
    await closedCard('shipped', true, 'One')
    await closedCard('failed_experiment', false, 'Two')
    await closedCard('abandoned', false, 'Three')
    await closedCard('superseded', false, 'Four')
    await closedCard('shipped', true, 'Five')

    const rows = await db.execute<{
      result: string
      evidence_present: boolean
      is_revision: boolean
    }>(
      sql`select result, evidence_present, is_revision
        from workplace_outcome_events order by at`,
    )
    expect(rows).toHaveLength(5)
    expect(rows.filter((row) => row.result === 'shipped')).toHaveLength(2)
    expect(rows.filter((row) => row.result === 'failed_experiment')).toHaveLength(1)
    expect(rows.filter((row) => row.result === 'abandoned')).toHaveLength(1)
    expect(rows.filter((row) => row.result === 'superseded')).toHaveLength(1)
    expect(rows.filter((row) => row.evidence_present)).toHaveLength(2)
    expect(rows.every((row) => row.is_revision === false)).toBe(true)
  })

  it('rolls back outcome event insert if the enclosing transaction fails', async () => {
    const created = await createCard(db, {
      callerId: owner,
      boardId,
      title: 'Rollback',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const link = await addLink(db, {
      callerId: owner,
      cardId: created.card.id,
      kind: 'url',
      ref: 'https://example.com/rollback',
    })
    if (link.outcome !== 'created') throw new Error('link missing')

    await expect(
      db.transaction(async (tx) => {
        const completed = await completeCard(tx as unknown as Database, {
          callerId: owner,
          cardId: created.card.id,
          expectedVersion: claimed.card.version,
          close: {
            result: 'shipped',
            summary: 'Closed Rollback.',
            learned: 'Learned before rollback.',
            evidenceLinkIds: [link.link.id],
            next: { kind: 'none' },
          },
        })
        expect(completed.outcome).toBe('completed')
        throw new Error('deliberate abort')
      }),
    ).rejects.toThrow('deliberate abort')

    const rows = await db.execute(sql`select 1 from workplace_outcome_events`)
    expect(rows).toHaveLength(0)
  })

  it('records a correction as a revision and never as a new closing', async () => {
    const completed = await closedCard('shipped', true, 'Corrected')
    const revised = await createCardClosure(db, {
      callerId: owner,
      cardId: completed.card.id,
      close: {
        result: 'failed_experiment',
        summary: 'Tried the public endpoint and observed a permanent 403 response.',
        learned: 'The route does not work.',
        evidenceLinkIds: [],
        next: { kind: 'none' },
        supersedesClosureId: completed.closure.id,
      },
    })
    expect(revised.outcome).toBe('created')

    const rows = await db.execute<{ result: string; is_revision: boolean }>(
      sql`select result, is_revision from workplace_outcome_events order by at`,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ result: 'shipped', is_revision: false })
    expect(rows[1]).toEqual({ result: 'failed_experiment', is_revision: true })
  })

  it('writes no event for a legacy outcome completion', async () => {
    const created = await createCard(db, {
      callerId: owner,
      boardId,
      title: 'Legacy',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')
    const done = await completeCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: claimed.card.version,
      outcome: 'The walk is filed.',
    })
    expect(done.outcome).toBe('completed')
    expect(await db.execute(sql`select 1 from workplace_outcome_events`)).toHaveLength(0)
  })

  it('writes no event when the closure transaction refuses', async () => {
    const created = await createCard(db, {
      callerId: owner,
      boardId,
      title: 'Refused',
      status: 'ready',
    })
    if (created.outcome !== 'created') throw new Error('card missing')
    const claimed = await claimCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: created.card.version,
    })
    if (claimed.outcome !== 'claimed') throw new Error('claim failed')

    const refused = await completeCard(db, {
      callerId: owner,
      cardId: created.card.id,
      expectedVersion: claimed.card.version,
      close: {
        result: 'shipped',
        summary: 'Closed Refused.',
        learned: 'Nothing.',
        evidenceLinkIds: [WorkplaceLinkIdSchema.parse('00000000-0000-0000-0000-000000000000')],
        next: { kind: 'none' },
      },
    })
    expect(refused.outcome).toBe('invalid-evidence')
    expect(await db.execute(sql`select 1 from workplace_outcome_events`)).toHaveLength(0)
  })

  it('suppresses weeks with fewer than ten initial closings inside the range', async () => {
    for (let index = 0; index < 9; index += 1) {
      await closedCard('shipped', true, `Thin ${index}`)
    }
    const to = new Date()
    const from = new Date(to.getTime() - 28 * 24 * 60 * 60 * 1000)
    const report = await workplaceOutcomeMetrics(db, {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    })
    expect(report.outcome).toBe('reported')
    if (report.outcome !== 'reported') return
    expect(report.buckets.length).toBeGreaterThan(0)
    for (const bucket of report.buckets) {
      expect(bucket.suppressed).toBe(true)
      expect('shipped' in bucket).toBe(false)
      expect('initialClosings' in bucket).toBe(false)
    }
  })

  it('reports a dense week with counts and separates revisions from initial closings', async () => {
    const completed = await closedCard('shipped', true, 'Dense')
    await createCardClosure(db, {
      callerId: owner,
      cardId: completed.card.id,
      close: {
        result: 'failed_experiment',
        summary: 'Tried the route and observed an error.',
        learned: 'The route does not work.',
        evidenceLinkIds: [],
        next: { kind: 'none' },
        supersedesClosureId: completed.closure.id,
      },
    })
    for (let index = 0; index < 9; index += 1) {
      if (index % 2 === 0) {
        await closedCard('shipped', true, `Fill ${index}`)
      } else {
        await closedCard('abandoned', false, `Fill ${index}`)
      }
    }
    const to = new Date()
    const from = new Date(to.getTime() - 28 * 24 * 60 * 60 * 1000)
    const report = await workplaceOutcomeMetrics(db, {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    })
    expect(report.outcome).toBe('reported')
    if (report.outcome !== 'reported') return
    const dense = report.buckets.find((bucket) => !bucket.suppressed && bucket.suppressed === false)
    expect(dense).toBeDefined()
    if (dense === undefined || dense.suppressed) return
    expect(dense.shipped).toBe(6)
    expect(dense.failedExperiment).toBe(1)
    expect(dense.abandoned).toBe(4)
    expect(dense.superseded).toBe(0)
    expect(dense.evidencePresent).toBe(6)
    expect(dense.initialClosings).toBe(10)
    expect(dense.closureRevisions).toBe(1)
  })

  it('refuses ranges shorter than 28 days, longer than 366 days or inverted', async () => {
    const to = '2026-09-14'
    const from = '2026-09-13'
    expect(await workplaceOutcomeMetrics(db, { from, to })).toEqual({ outcome: 'invalid-range' })
    expect(await workplaceOutcomeMetrics(db, { from: '2026-09-15', to: '2026-09-14' })).toEqual({
      outcome: 'invalid-range',
    })
    expect(await workplaceOutcomeMetrics(db, { from: '2025-01-01', to: '2026-12-31' })).toEqual({
      outcome: 'invalid-range',
    })
    expect(await workplaceOutcomeMetrics(db, { from: '2026-13-01', to: '2026-09-14' })).toEqual({
      outcome: 'invalid-range',
    })
  })

  it('is read by nothing that pays, grants, ranks or recommends', () => {
    const forbidden = [
      'rewards.ts',
      'balance.ts',
      'skills.ts',
      'citizenship.ts',
      'payouts.ts',
      'wakeup.ts',
      'wakeup-state.ts',
      'tasks.ts',
    ]

    for (const file of forbidden) {
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8')

      expect(
        source.includes('workplaceOutcomeEvents'),
        `${file} must not read outcome telemetry`,
      ).toBe(false)
      expect(
        source.includes('workplace_outcome_events'),
        `${file} must not read outcome telemetry`,
      ).toBe(false)
      expect(
        source.includes('workplaceOutcomeMetrics'),
        `${file} must not read outcome telemetry`,
      ).toBe(false)
    }
  })

  it('holds only the five telemetry columns and no identifying or prose field', async () => {
    const rows = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'workplace_outcome_events'
        order by ordinal_position`,
    )
    expect(rows.map((row) => row.column_name)).toEqual([
      'id',
      'result',
      'evidence_present',
      'is_revision',
      'at',
    ])
    const schemaSource = readFileSync(
      fileURLToPath(new URL('../schema/workplace.ts', import.meta.url)),
      'utf8',
    )
    const marker = 'export const workplaceOutcomeEvents = pgTable('
    const start = schemaSource.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)
    const tableDefinition = schemaSource.slice(start)
    expect(tableDefinition).not.toMatch(
      /\b(agent_id|board_id|card_id|closure_id|title|summary|learned|evidence_ref|owner_id|actor_id|profession|membership)\b/i,
    )
  })
})
