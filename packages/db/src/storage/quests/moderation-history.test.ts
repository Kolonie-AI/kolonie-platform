import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { noStagesRun } from '@kolonie-ai/core'
import type { Database } from '../../client.js'
import { questModerations, tasks } from '../../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../../testing.js'
import { questModerationHistory } from './index.js'

const target = databaseTestTarget()

/** The verdicts behind the maintainer's moderation screen (`#814`). */
describe('quest moderation history', () => {
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

  const quest = async (title: string): Promise<string> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'quest-report',
        kind: 'quest',
        title,
        description: 'Text the moderation history must not return.',
        instructions: 'More judged text that belongs nowhere on the audit screen.',
        rewardReputation: 1,
        timeoutHours: 24,
        questions: [],
        status: 'pending_review',
      })
      .returning({ id: tasks.id })

    return row!.id
  }

  it('keeps every verdict newest first and names the stage that refused it', async () => {
    const first = await quest('First registration question')
    const second = await quest('Second registration question')
    const rejected = noStagesRun()
    rejected.quality = {
      outcome: 'unanswerable',
      reason: 'The success criterion cannot be checked from the requested answer.',
    }

    await db.insert(questModerations).values([
      {
        taskId: first,
        decision: 'approved',
        model: 'model-one',
        stages: noStagesRun(),
        contentSha256: 'a'.repeat(64),
        createdAt: '2026-07-01T10:00:00.000Z',
      },
      {
        taskId: first,
        decision: 'rejected',
        model: 'model-two',
        stages: rejected,
        contentSha256: 'b'.repeat(64),
        createdAt: '2026-08-01T10:00:00.000Z',
      },
      {
        taskId: second,
        decision: 'approved',
        model: 'model-three',
        stages: noStagesRun(),
        contentSha256: 'c'.repeat(64),
        createdAt: '2026-08-02T10:00:00.000Z',
      },
    ])

    const rows = await questModerationHistory(db)

    expect(rows.map((row) => row.model)).toEqual(['model-three', 'model-two', 'model-one'])
    expect(rows[1]).toMatchObject({
      subject: { id: first, title: 'First registration question' },
      decision: 'rejected',
      refusedAt: 'quality',
      refusalReason: 'The success criterion cannot be checked from the requested answer.',
      createdAt: '2026-08-01T10:00:00.000Z',
    })
    expect(rows[0]).not.toHaveProperty('contentSha256')
    expect(rows[0]).not.toHaveProperty('description')
    expect(rows[0]).not.toHaveProperty('instructions')
  })

  it('filters by quest title or id and by decision', async () => {
    const first = await quest('A registration question')
    const second = await quest('A billing question')

    await db.insert(questModerations).values([
      {
        taskId: first,
        decision: 'approved',
        model: 'model-one',
        stages: noStagesRun(),
        contentSha256: 'a'.repeat(64),
      },
      {
        taskId: second,
        decision: 'rejected',
        model: 'model-two',
        stages: {
          ...noStagesRun(),
          redLine: { outcome: 'crossed', reason: 'The quest asks for a credential.' },
        },
        contentSha256: 'b'.repeat(64),
      },
    ])

    expect(
      (await questModerationHistory(db, { subject: 'REGISTRATION' })).map((row) => row.subject.id),
    ).toEqual([first])
    expect(
      (await questModerationHistory(db, { subject: second.slice(0, 12) })).map(
        (row) => row.subject.id,
      ),
    ).toEqual([second])
    expect(
      (await questModerationHistory(db, { decision: 'rejected' })).map((row) => row.subject.id),
    ).toEqual([second])
  })
})
