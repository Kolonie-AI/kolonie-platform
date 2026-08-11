import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { authorityEvents, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { wakeupChanges } from './wakeup.js'

const target = databaseTestTarget()

describe('sponsored quest changes in the wake-up digest', () => {
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

  const anAgent = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aQuest = async (sponsor: AgentId, title: string) => {
    const [quest] = await db
      .insert(tasks)
      .values({
        type: `quest-${title.toLowerCase().replaceAll(' ', '-')}`,
        kind: 'quest',
        title,
        description: 'A question worth asking independently.',
        instructions: 'Answer the stated question.',
        rewardReputation: 0,
        rewardLamports: 1_000_000,
        timeoutHours: 24,
        status: 'awaiting_payment',
        slots: 2,
        invoiceLamports: 2_000_000,
        awaitingPaymentSince: '2026-08-01T10:00:00.000Z',
        createdBy: sponsor,
      })
      .returning({ id: tasks.id })
    if (quest === undefined) throw new Error('inserting a quest returned no row')
    return quest.id
  }

  it('returns only the caller’s quest transitions inside the window', async () => {
    const sponsor = await anAgent('sponsor')
    const bystander = await anAgent('bystander')
    const own = await aQuest(sponsor, 'Own quest')
    const theirs = await aQuest(bystander, 'Other quest')

    await db.insert(authorityEvents).values([
      {
        action: 'quest-published',
        subjectAgentId: sponsor,
        subjectTaskId: own,
        at: '2026-08-01T10:00:00.000Z',
      },
      {
        action: 'quest-published',
        subjectAgentId: bystander,
        subjectTaskId: theirs,
        at: '2026-08-01T10:00:00.000Z',
      },
    ])

    const digest = await wakeupChanges(db, sponsor, '2026-08-01T09:00:00.000Z')

    expect(digest.sponsoredQuests).toEqual([
      {
        taskId: own,
        title: 'Own quest',
        transition: 'awaiting_payment',
        changedAt: '2026-08-01T10:00:00.000Z',
        invoiceLamports: 2_000_000,
      },
    ])
  })

  it('returns no quest transition outside the window', async () => {
    const sponsor = await anAgent('sponsor')
    const quest = await aQuest(sponsor, 'Old quest')
    await db.insert(authorityEvents).values({
      action: 'quest-published',
      subjectAgentId: sponsor,
      subjectTaskId: quest,
      at: '2026-08-01T08:00:00.000Z',
    })

    expect((await wakeupChanges(db, sponsor, '2026-08-01T09:00:00.000Z')).sponsoredQuests).toEqual(
      [],
    )
  })

  it('reports an invoiced quest as published when payment made it live', async () => {
    const sponsor = await anAgent('sponsor')
    const quest = await aQuest(sponsor, 'Paid quest')
    await db.insert(authorityEvents).values({
      action: 'quest-published',
      subjectAgentId: sponsor,
      subjectTaskId: quest,
      at: '2026-08-01T08:00:00.000Z',
    })
    await db.update(tasks).set({
      status: 'active',
      awaitingPaymentSince: null,
      paidLamports: 2_000_000,
      updatedAt: '2026-08-01T10:00:00.000Z',
    })

    expect((await wakeupChanges(db, sponsor, '2026-08-01T09:00:00.000Z')).sponsoredQuests).toEqual([
      {
        taskId: quest,
        title: 'Paid quest',
        transition: 'published',
        changedAt: '2026-08-01T10:00:00.000Z',
      },
    ])
  })
})
