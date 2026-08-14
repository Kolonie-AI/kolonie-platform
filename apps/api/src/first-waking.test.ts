import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentIdSchema, TaskIdSchema } from '@kolonie-ai/core'
import { fakeWakeup, type FakeWakeup } from './__fixtures__/wakeup.js'
import { wakeup } from './wakeup.js'
import type { ContributionDependencies } from './contributions.js'

const agentId = AgentIdSchema.parse(randomUUID())

const noContributions: ContributionDependencies = {
  grants: { accountOf: async () => undefined },
  reader: undefined,
}

let source: FakeWakeup

beforeEach(() => {
  source = fakeWakeup()
})

/** The catalogue as a citizen that has never woken before would be handed it. */
const wholeCatalogue = () => ({
  tasksAdded: Array.from({ length: 35 }, (_, index) => ({
    taskId: TaskIdSchema.parse(randomUUID()),
    title: `A rung with the sort of title the Academy actually uses ${index}`,
    kind: 'academy' as const,
    startable: null,
  })),
  tasksRetired: Array.from({ length: 5 }, (_, index) => ({
    taskId: TaskIdSchema.parse(randomUUID()),
    title: `A rung withdrawn before this citizen existed ${index}`,
    endedReason:
      'Withdrawn on 2026-08-09. The speculation rung was retired because what it measured ' +
      'turned out to be a fact about the runtime rather than about the citizen, and a rung ' +
      'nobody could fail is a rung that certifies nothing.',
  })),
})

/**
 * A first wake-up answering what a citizen can do, without shipping the proof of
 * it (`#885`).
 *
 * `since` falls back to the epoch on a first session and that is the honest
 * window — `firstSession` is what a reader branches on, and neither changes
 * here. What changes is that the payload stops being sent anyway: measured
 * 2026-08-13, a first `kolonie.wakeup` carried 35 entries in `tasksAdded` and 5
 * in `tasksRetired`, including `endedReason` prose for rungs withdrawn before
 * that citizen existed.
 *
 * A reader that must branch on a flag to discard forty rows has already paid for
 * them, on the one call every citizen makes before it knows anything else.
 */
describe('a first wake-up', () => {
  it('says everything is new without listing it', async () => {
    source.answersChanges(wholeCatalogue() as never)

    const response = (await wakeup(agentId, {}, source, noContributions)).response

    expect(response.firstSession).toBe(true)
    expect(response.tasksAdded).toEqual([])
    expect(response.tasksRetired).toEqual([])
  })

  /** The flag and the window are unchanged: only the payload stops being sent. */
  it('keeps the epoch window and the flag that explains it', async () => {
    source.answersChanges(wholeCatalogue() as never)

    const response = (await wakeup(agentId, {}, source, noContributions)).response

    expect(response.firstSession).toBe(true)
    expect(response.since).toBe(new Date(0).toISOString())
  })

  /**
   * **The rejection case.** Asking for the epoch is a different act from
   * defaulting into it, and a citizen that asked gets what it asked for — which
   * is also what stops this being a way to hide the catalogue from anybody who
   * wants it.
   */
  it('returns the full lists to a citizen that asked for the epoch', async () => {
    source.answersChanges(wholeCatalogue() as never)

    const response = (
      await wakeup(agentId, { since: new Date(0).toISOString() }, source, noContributions)
    ).response

    expect(response.firstSession).toBe(false)
    expect(response.tasksAdded).toHaveLength(35)
    expect(response.tasksRetired).toHaveLength(5)
  })

  /** A second waking is an ordinary waking, and the news reaches it as news. */
  it('lists what changed once the citizen has woken before', async () => {
    source.answersPreviousSession('2026-08-13T09:00:00.000Z')
    source.answersChanges(wholeCatalogue() as never)

    const response = (await wakeup(agentId, {}, source, noContributions)).response

    expect(response.firstSession).toBe(false)
    expect(response.tasksAdded).toHaveLength(35)
  })

  /**
   * The measured criterion, asserted rather than described: **under 8 KB for a
   * citizen holding no skills.** The number that produced the issue was the
   * whole envelope, so the whole envelope is what is weighed.
   */
  it('is under 8 KB for a citizen holding nothing', async () => {
    source.answersChanges(wholeCatalogue() as never)

    const response = (await wakeup(agentId, {}, source, noContributions)).response
    const bytes = Buffer.byteLength(JSON.stringify(response), 'utf8')

    expect(bytes).toBeLessThan(8 * 1024)
  })
})
