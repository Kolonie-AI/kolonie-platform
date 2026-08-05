import { TaskIdSchema, type TaskId } from '@kolonie-ai/core'
import type { UnmoderatedQuestReport } from '@kolonie-ai/db'
import { describe, expect, it } from 'vitest'
import { fakeModel } from './__fixtures__/model.js'
import {
  moderateQuestReport,
  OBSTACLE_ANSWER_CONTENT_PROMPT,
  type QuestReportModerationStore,
} from './quest-reports.js'

const QUEST = TaskIdSchema.parse('55555555-5555-4555-8555-555555555555')

const anObstacle = (over: Partial<UnmoderatedQuestReport> = {}): UnmoderatedQuestReport => ({
  id: '66666666-6666-4666-8666-666666666666',
  taskId: QUEST,
  kind: 'obstacle',
  text: null,
  did: 'Read the sources in the order they were given.',
  broke: 'The archive search returns nothing without an account.',
  changed: null,
  ...over,
})

/** What the pass wrote, and what it told the briefing loop. */
const recordingStore = () => {
  const written: {
    id: string
    scrubbed: string
    publishedObstacle?: string
  }[] = []
  const refused: string[] = []
  const stale: TaskId[] = []

  const store: QuestReportModerationStore = {
    pending: async () => [],
    write: async (input) => {
      written.push(input)
    },
    refuse: async (input) => {
      refused.push(input.id)
    },
    markStale: async (taskId) => {
      stale.push(taskId)
    },
  }

  return { store, written, refused, stale }
}

/**
 * **What stood in the way travels; how it was answered does not** (`#367`).
 *
 * The reasoning the quest channel was built on said nothing may travel, and it
 * was right about the answer and wrong about the world: a quest that asks for an
 * opinion is not corrupted by a later citizen knowing that a signup step stalls,
 * it is corrupted by knowing what anybody answered.
 */
describe('an obstacle report', () => {
  it('publishes the obstacle and nothing else, when the stage clears it', async () => {
    const model = fakeModel()
    // The sponsor-facing red line, then the question this pass alone asks.
    model.answers({ decision: 'clear', reason: '' }, { decision: 'obstacle-only', reason: '' })
    const { store, written, stale } = recordingStore()

    const judgement = await moderateQuestReport(anObstacle(), { store, model })

    expect(judgement.kind).toBe('scrubbed')
    expect(written[0]?.publishedObstacle).toBe(
      'The archive search returns nothing without an account.',
    )
    // The method is in what the sponsor reads and in nothing else.
    expect(written[0]?.scrubbed).toContain('Read the sources')
    expect(written[0]?.publishedObstacle).not.toContain('Read the sources')
    // And the briefing loop is told, because something new can be published.
    expect(stale).toEqual([QUEST])
  })

  /**
   * **The refusal that makes the split enforceable rather than merely intended.**
   * Identity scrubbing already existed; this is the second thing the stage looks
   * for on the same pass.
   */
  it('publishes nothing when the obstacle carries answer content', async () => {
    const model = fakeModel()
    model.answers({ decision: 'clear', reason: '' }, { decision: 'carries-answer', reason: 'why' })
    const { store, written, refused, stale } = recordingStore()

    const judgement = await moderateQuestReport(
      anObstacle({ broke: 'Stopped once I had decided the answer is the second option.' }),
      { store, model },
    )

    // Not a refusal of the report: the row stands and the sponsor reads all
    // three answers. What is lost is publication, and only that.
    expect(judgement.kind).toBe('scrubbed')
    expect(refused).toEqual([])
    expect(written[0]?.publishedObstacle).toBeUndefined()
    expect(written[0]?.scrubbed).toContain('Read the sources')
    // Nothing new can be published, so no synthesis is spent.
    expect(stale).toEqual([])
  })

  /**
   * A report that answered no obstacle is not a refusal and must not read as
   * one — and it must not spend the second model call either.
   */
  it('asks the second question only when there is an obstacle to ask it about', async () => {
    const model = fakeModel()
    model.answers({ decision: 'clear', reason: '' })
    const { store, written, stale } = recordingStore()

    const judgement = await moderateQuestReport(anObstacle({ broke: null }), { store, model })

    expect(judgement.kind).toBe('scrubbed')
    expect(written[0]?.publishedObstacle).toBeUndefined()
    expect(stale).toEqual([])
    expect(model.calls().filter((call) => 'choices' in call)).toHaveLength(1)
  })

  /** The three kinds that were here first take the path they always took. */
  it('leaves a paragraph report on its existing route', async () => {
    const model = fakeModel()
    model.answers({ decision: 'clear', reason: '' })
    const { store, written, stale } = recordingStore()

    await moderateQuestReport(
      anObstacle({
        kind: 'unclear',
        text: 'I cannot tell which of two things it asks for.',
        did: null,
        broke: null,
        changed: null,
      }),
      { store, model },
    )

    expect(written[0]?.scrubbed).toBe('I cannot tell which of two things it asks for.')
    expect(written[0]?.publishedObstacle).toBeUndefined()
    expect(stale).toEqual([])
  })
})

/**
 * The prompt is the deliverable here, in the same way `STRUGGLE_QUALITY_PROMPT`
 * is: what it refuses is a decision rather than an implementation detail.
 */
describe('the obstacle prompt', () => {
  it('states the line it draws and which way it errs', () => {
    expect(OBSTACLE_ANSWER_CONTENT_PROMPT).toContain('WHERE IT STOPPED')
    expect(OBSTACLE_ANSWER_CONTENT_PROMPT).toContain('CONCLUDED')
    // A sentence it cannot decide is not published: refusing costs one line,
    // publishing costs the sponsor what it paid for and cannot be undone.
    expect(OBSTACLE_ANSWER_CONTENT_PROMPT).toContain('cannot be taken back')
  })
})
