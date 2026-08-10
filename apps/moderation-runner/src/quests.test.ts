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

const recording = (quests: readonly PendingQuest[] = [aQuest()]) => {
  const written: Parameters<QuestModerationStore['record']>[0][] = []
  const store: QuestModerationStore = {
    pending: async () => quests,
    record: async (input) => {
      written.push(input)
      return { outcome: 'written' }
    },
  }
  return { store, written }
}

/**
 * The one stage a quest's text passes before a steward reads it (`#176`).
 *
 * What is asserted here is what the stage must never do: refuse a quest for
 * being dull, refuse one because the model was unreachable, or approve one
 * whose text has moved since it was read.
 */
describe('moderating a quest', () => {
  it('clears an ordinary brief and records that the other stages never ran', async () => {
    const { store, written } = recording()
    const { model } = answering('clear')

    const judgement = await judgeQuest(aQuest(), { store, model })

    expect(judgement).toEqual({ kind: 'approved' })
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
    const store: QuestModerationStore = {
      pending: async () => [aQuest()],
      record: async () => ({ outcome: 'stale' }),
    }

    expect(await judgeQuest(aQuest(), { store, model })).toEqual({ kind: 'stale' })
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

    expect(outcome).toEqual({ judged: 2, approved: 0, rejected: 2, failed: 0 })
  })
})
