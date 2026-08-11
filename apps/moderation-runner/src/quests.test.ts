import { describe, expect, it } from 'vitest'
import { MODERATION_STAGE_NOT_RUN, type TaskId } from '@kolonie-ai/core'
import type { PendingQuest } from '@kolonie-ai/db'
import type { Model } from './llm.js'
import {
  QUEST_RED_LINE_PROMPT,
  judgeQuest,
  questTick,
  type QuestModerationStore,
} from './quests.js'

const aQuest = (overrides: Partial<PendingQuest> = {}): PendingQuest => ({
  id: '11111111-1111-4111-8111-111111111111' as TaskId,
  title: 'A thousand registrations',
  description: 'We hand out mailbox addresses and want to know whether agents can take one.',
  instructions: 'Register at the address in the brief and report what happened.',
  ...overrides,
})

/** A model that answers what the test tells it to, and records what it was asked. */
const answering = (
  decision: 'clear' | 'crossed',
  reason = 'It asks for a captcha to be solved.',
  responseModel?: string,
) => {
  const asked: { system: string; user: string }[] = []
  const model: Model = {
    name: 'test-model',
    classify: async (request) => {
      asked.push({ system: request.system, user: request.user })
      return {
        decision,
        reason,
        ...(responseModel === undefined
          ? {}
          : {
              call: {
                route: 'openrouter' as const,
                model: responseModel,
                tokens: { prompt: 308, completion: 5, total: 313 },
              },
            }),
      }
    },
    mark: async () => [],
    compose: async () => [],
    embed: async () => [],
  }
  return { model, asked }
}

const recording = (
  quests: readonly PendingQuest[] = [aQuest()],
  options: {
    /** What publishing does. Publishes, unless a test says otherwise. */
    readonly publish?: QuestModerationStore['publish']
    /** Verdicts an earlier pass recorded and did not act on. */
    readonly cleared?: readonly TaskId[]
  } = {},
) => {
  const written: Parameters<QuestModerationStore['record']>[0][] = []
  const publishedIds: TaskId[] = []
  const store: QuestModerationStore = {
    pending: async () => quests,
    record: async (input) => {
      written.push(input)
      return { outcome: 'written' }
    },
    cleared: async () => options.cleared ?? [],
    publish: async (taskId) => {
      publishedIds.push(taskId)
      return options.publish === undefined
        ? { outcome: 'published', escrowed: 0 }
        : await options.publish(taskId)
    },
  }
  return { store, written, publishedIds }
}

/**
 * The stage that decides whether a quest is published (`#176`, `#693`).
 *
 * What is asserted here is what it must never do: refuse a quest for being dull,
 * refuse one because the model was unreachable, or approve one whose text has
 * moved since it was read. Those were the properties that made a mechanical
 * stage acceptable when a steward still read everything afterwards; with the
 * verdict now being the decision they are the properties the whole design rests
 * on, and none of them changed.
 */
describe('moderating a quest', () => {
  it('clears an ordinary brief and records that the other stages never ran', async () => {
    const { store, written } = recording()
    const { model } = answering('clear')

    const judgement = await judgeQuest(aQuest(), { store, model })

    expect(judgement).toEqual({
      kind: 'approved',
      published: { outcome: 'published', escrowed: 0 },
    })
    expect(written[0]?.decision).toBe('approved')
    expect(written[0]?.stages.redLine).toEqual({ outcome: 'clear' })
    // Three keys say `not-run` rather than saying nothing: *the quality check
    // passed it* and *the quality check never looked* must stay different rows.
    expect(written[0]?.stages.quality.outcome).toBe(MODERATION_STAGE_NOT_RUN)
    expect(written[0]?.stages.confidentiality.outcome).toBe(MODERATION_STAGE_NOT_RUN)
    expect(written[0]?.stages.dedup.outcome).toBe(MODERATION_STAGE_NOT_RUN)
  })

  it('refuses a red-line quest with a reason the sponsor can act on', async () => {
    const { store, written } = recording()
    const { model } = answering('crossed', 'It asks the citizen to defeat a captcha.')

    const judgement = await judgeQuest(aQuest(), { store, model })

    expect(judgement.kind).toBe('rejected')
    expect(written[0]?.decision).toBe('rejected')
    expect(written[0]?.reason).toContain('red lines')
    expect(written[0]?.reason).toContain('defeat a captcha')
    expect(written[0]?.stages.redLine.outcome).toBe('crossed')
  })

  it('records the model that answered rather than the configured model', async () => {
    const { store, written } = recording()
    const { model } = answering('clear', '', 'provider/model-that-answered')

    await judgeQuest(aQuest(), { store, model })

    expect(written[0]?.model).toBe('provider/model-that-answered')
  })

  it('shows the model the whole brief, and nothing about who wrote it', async () => {
    const { store } = recording()
    const { model, asked } = answering('clear')
    const quest = aQuest()

    await judgeQuest(quest, { store, model })

    expect(asked[0]?.system).toBe(QUEST_RED_LINE_PROMPT)
    expect(asked[0]?.user).toContain(quest.title)
    expect(asked[0]?.user).toContain(quest.description)
    expect(asked[0]?.user).toContain(quest.instructions)
    expect(asked[0]?.user).not.toContain(quest.id)
  })

  /**
   * The failure direction that matters: a sponsor whose quest was refused
   * because the Colony could not reach its own moderator would have been told
   * its brief crossed a line it did not cross.
   */
  it('writes nothing when the model is unreachable', async () => {
    const { store, written } = recording()
    const model: Model = {
      name: 'test-model',
      classify: async () => {
        throw new Error('upstream is down')
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }

    const judgement = await judgeQuest(aQuest(), { store, model })

    expect(judgement.kind).toBe('failed')
    expect(written).toEqual([])
  })

  it('reports a verdict that arrived after the quest moved on', async () => {
    const { model } = answering('clear')
    const { store } = recording()
    const stale: QuestModerationStore = { ...store, record: async () => ({ outcome: 'stale' }) }

    expect(await judgeQuest(aQuest(), { store: stale, model })).toEqual({ kind: 'stale' })
  })

  it('carries the text it judged, so a stale verdict can be detected at all', async () => {
    const { store, written } = recording()
    const { model } = answering('clear')
    const quest = aQuest()

    await judgeQuest(quest, { store, model })

    expect(written[0]?.judged).toEqual({
      title: quest.title,
      description: quest.description,
      instructions: quest.instructions,
    })
  })

  it('counts a batch by what each judgement was', async () => {
    const { store } = recording([
      aQuest(),
      aQuest({ id: '22222222-2222-4222-8222-222222222222' as TaskId }),
    ])
    const { model } = answering('crossed')

    const outcome = await questTick({ store, model }, 10)

    expect(outcome).toEqual({
      judged: 2,
      approved: 0,
      rejected: 2,
      failed: 0,
      published: 0,
      released: 0,
    })
  })
})

/**
 * The half `#693` added: an approved verdict is a publication.
 *
 * **The clause the whole design rests on is the last three tests**, and they are
 * not optional. An outage must never publish, and must never turn away a sponsor
 * who did nothing wrong — so every way this can fail has to leave the quest
 * exactly where it was, in `pending_review`, for the next tick.
 */
describe('publishing what moderation approved', () => {
  it('publishes the quest it cleared, and names no steward doing it', async () => {
    const { store, publishedIds } = recording()
    const { model } = answering('clear')
    const quest = aQuest()

    const judgement = await judgeQuest(quest, { store, model })

    expect(judgement).toEqual({
      kind: 'approved',
      published: { outcome: 'published', escrowed: 0 },
    })
    // The store's `publish` takes a task id and nothing else. There is no
    // parameter here for a steward, which is the point rather than an omission.
    expect(publishedIds).toEqual([quest.id])
  })

  it('does not publish a quest it refused', async () => {
    const { store, publishedIds } = recording()
    const { model } = answering('crossed')

    await judgeQuest(aQuest(), { store, model })

    expect(publishedIds).toEqual([])
  })

  it('counts a quest waiting for its money as published', async () => {
    const { store } = recording([aQuest()], {
      publish: async () => ({ outcome: 'awaiting-payment', invoiceLamports: 5_000_000 }),
    })
    const { model } = answering('clear')

    const outcome = await questTick({ store, model }, 10)

    // D-106: a SOL-priced quest is published and waiting for a transfer. The
    // sponsor has its answer, which is what this counter is about.
    expect(outcome.approved).toBe(1)
    expect(outcome.published).toBe(1)
  })

  it('separates a quest the model cleared from one the audit brake stopped', async () => {
    const { store } = recording([aQuest()], {
      publish: async () => ({ outcome: 'audit-missing', reason: 'sampling is not enabled' }),
    })
    const { model } = answering('clear')

    const outcome = await questTick({ store, model }, 10)

    // Cleared, and not in front of anybody. A runner that reported only
    // `approved` would say the sponsor was answered when it was not.
    expect(outcome.approved).toBe(1)
    expect(outcome.published).toBe(0)
  })

  /**
   * The three failure modes `#693` names — an unreachable gateway, a timeout, a
   * malformed answer — reach this function as a throw from `classify`, and one
   * assertion covers all three: nothing was written, so the quest is untouched
   * and the next tick judges it again.
   */
  it('leaves the quest for the next tick when the model cannot be reached', async () => {
    const { store, written, publishedIds } = recording()
    const model: Model = {
      name: 'test-model',
      classify: async () => {
        throw new Error('gateway timeout')
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }

    const judgement = await judgeQuest(aQuest(), { store, model })

    expect(judgement.kind).toBe('failed')
    expect(written).toEqual([])
    expect(publishedIds).toEqual([])
  })

  /**
   * The window the two transactions open, and the reason `cleared` exists.
   *
   * A verdict is recorded and the publication throws — the process died, the
   * database blinked, the audit read failed. The quest is then judged and not
   * released, and `pending` will never return it again because it *has* been
   * judged. Without the retry it would sit in `pending_review` until somebody
   * noticed, which is the sponsor waiting forever that this issue exists to end.
   */
  it('releases a verdict an earlier pass recorded and could not act on', async () => {
    const stranded = '33333333-3333-4333-8333-333333333333' as TaskId
    // Nothing to judge this pass: the queue is empty and the stranded quest is
    // not in it, which is exactly the state that made it invisible.
    const { store, publishedIds } = recording([], { cleared: [stranded] })
    const { model } = answering('clear')

    const outcome = await questTick({ store, model }, 10)

    expect(publishedIds).toEqual([stranded])
    expect(outcome.released).toBe(1)
    expect(outcome.judged).toBe(0)
  })

  it('costs no model call to release one', async () => {
    const { store } = recording([], { cleared: ['33333333-3333-4333-8333-333333333333' as TaskId] })
    const { model, asked } = answering('clear')

    await questTick({ store, model }, 10)

    // Re-judging would buy a second chance to answer differently about text
    // that has not changed. The recorded verdict is the verdict.
    expect(asked).toEqual([])
  })

  it('survives a release that throws, and counts it as deferred', async () => {
    const { store } = recording([], {
      cleared: ['33333333-3333-4333-8333-333333333333' as TaskId],
      publish: async () => {
        throw new Error('the database blinked')
      },
    })
    const { model } = answering('clear')

    // A throw here must not take the pass down: the quest keeps its verdict and
    // the next tick tries again.
    const outcome = await questTick({ store, model }, 10)

    expect(outcome.failed).toBe(1)
    expect(outcome.released).toBe(0)
  })
})
