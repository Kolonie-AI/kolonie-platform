import { describe, expect, it } from 'vitest'
import { MODERATION_STAGE_NOT_RUN } from '@kolonie-ai/core'
import type { PendingPlaybook } from '@kolonie-ai/db'
import type { Model } from './llm.js'
import {
  PLAYBOOK_CONFIDENTIALITY_PROMPT,
  PLAYBOOK_QUALITY_PROMPT,
  PLAYBOOK_RED_LINE_PROMPT,
} from './playbook-prompts.js'
import { judgePlaybook, playbookTick, type PlaybookModerationStore } from './playbooks.js'

const aPlaybook = (overrides: Partial<PendingPlaybook> = {}): PendingPlaybook => ({
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'weekly-ticket-sweep',
  title: 'Answer the week’s unanswered support tickets',
  summary: 'Read what nobody has answered, write one reply, and say what you could not answer.',
  steps: [
    { title: 'Read the open tickets', usesSlots: ['mailbox'] },
    { title: 'Write one reply', detail: 'One answered properly beats four acknowledged.' },
  ],
  ...overrides,
})

/**
 * A model that answers each stage in that stage's own vocabulary.
 *
 * **Keyed on the prompt rather than on call order**, exactly as the quest fake
 * is and for the same reason: the order is part of what is under test, and a
 * fake that answered the second call `unfollowable` whatever it was sent would
 * pass a pipeline that ran the stages backwards.
 */
const answering = (
  verdicts: {
    readonly redLine?: 'clear' | 'crossed'
    readonly quality?: 'followable' | 'unfollowable'
    readonly confidentiality?: 'clean' | 'overreaching'
  } = {},
  reason = 'Step two never says how the follower would know the reply was sent.',
  responseModel?: string,
) => {
  const asked: { system: string; user: string }[] = []
  const model: Model = {
    name: 'test-model',
    classify: async (request) => {
      asked.push({ system: request.system, user: request.user })

      const decision =
        request.system === PLAYBOOK_RED_LINE_PROMPT
          ? (verdicts.redLine ?? 'clear')
          : request.system === PLAYBOOK_QUALITY_PROMPT
            ? (verdicts.quality ?? 'followable')
            : (verdicts.confidentiality ?? 'clean')

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

/** Which stage each call was, read back off the prompt it was sent. */
const stagesAsked = (asked: readonly { system: string }[]): readonly string[] =>
  asked.map((one) =>
    one.system === PLAYBOOK_RED_LINE_PROMPT
      ? 'redLine'
      : one.system === PLAYBOOK_QUALITY_PROMPT
        ? 'quality'
        : one.system === PLAYBOOK_CONFIDENTIALITY_PROMPT
          ? 'confidentiality'
          : 'some prompt this test does not know',
  )

const recording = (
  playbooks: readonly PendingPlaybook[] = [aPlaybook()],
  options: {
    readonly publish?: PlaybookModerationStore['publish']
    readonly cleared?: readonly string[]
    readonly record?: PlaybookModerationStore['record']
  } = {},
) => {
  const written: Parameters<PlaybookModerationStore['record']>[0][] = []
  const publishedIds: string[] = []
  const store: PlaybookModerationStore = {
    pending: async () => playbooks,
    record: async (input) => {
      written.push(input)
      return options.record === undefined ? { outcome: 'written' } : await options.record(input)
    },
    cleared: async () => options.cleared ?? [],
    publish: async (playbookId) => {
      publishedIds.push(playbookId)
      return options.publish === undefined
        ? { outcome: 'published', slug: aPlaybook().slug }
        : await options.publish(playbookId)
    },
  }
  return { store, written, publishedIds }
}

/**
 * The stage that decides whether a playbook is published (`#1219`).
 *
 * **The verdict is the decision**, as it is for quests: nobody reads it
 * afterwards. So what is asserted here is what it must never do — refuse a
 * playbook for being terse, refuse one because the model was unreachable,
 * publish one it never approved, or tell an author which red line it crossed.
 */
describe('moderating a playbook', () => {
  it('clears an ordinary pipeline and records the three stages that ran', async () => {
    const { store, written, publishedIds } = recording()
    const { model, asked } = answering()

    const judgement = await judgePlaybook(aPlaybook(), { store, model })

    expect(judgement).toEqual({
      kind: 'approved',
      published: { outcome: 'published', slug: 'weekly-ticket-sweep' },
    })
    expect(stagesAsked(asked)).toEqual(['redLine', 'quality', 'confidentiality'])
    expect(written).toHaveLength(1)
    expect(written[0]?.decision).toBe('approved')
    expect(written[0]?.stages.redLine).toEqual({ outcome: 'clear' })
    expect(written[0]?.stages.quality).toEqual({ outcome: 'followable' })
    expect(written[0]?.stages.confidentiality).toEqual({ outcome: 'clean' })
    expect(publishedIds).toEqual([aPlaybook().id])
  })

  /**
   * Freeze D makes a fork of a published playbook a first-class thing to write,
   * so a dedup stage would refuse the feature. It stays `not-run` — and this is
   * the assertion that says so out loud, because *the fourth key is empty* looks
   * exactly like *somebody forgot the fourth stage*.
   */
  it('never asks the dedup question', async () => {
    const { store, written } = recording()
    const { model, asked } = answering()

    await judgePlaybook(aPlaybook(), { store, model })

    expect(asked).toHaveLength(3)
    expect(written[0]?.stages.dedup).toEqual({ outcome: MODERATION_STAGE_NOT_RUN })
  })

  it('shows the model exactly the text the digest covers', async () => {
    const { store } = recording()
    const { model, asked } = answering()

    await judgePlaybook(aPlaybook(), { store, model })

    const brief = asked[0]?.user ?? ''
    expect(brief).toContain(aPlaybook().title)
    expect(brief).toContain(aPlaybook().summary)
    expect(brief).toContain('Read the open tickets')
    expect(brief).toContain('One answered properly beats four acknowledged.')
  })

  it('stops at the first refusal rather than paying for the stages behind it', async () => {
    const { store, written, publishedIds } = recording()
    const { model, asked } = answering(
      { redLine: 'crossed' },
      'It asks the follower to tick a box saying it is human.',
    )

    const judgement = await judgePlaybook(aPlaybook(), { store, model })

    expect(judgement.kind).toBe('rejected')
    expect(stagesAsked(asked)).toEqual(['redLine'])
    expect(written[0]?.decision).toBe('rejected')
    expect(publishedIds).toHaveLength(0)
  })

  /**
   * The asymmetry (`#694`, and it is the whole reason two registers exist). A
   * red-line refusal names nothing to the author and records everything for the
   * Colony; a correctable one carries the model's sentence out to the draft.
   */
  it('withholds the red line from the author and records it for the Colony', async () => {
    const { store, written } = recording()
    const told = 'It asks the follower to tick a box saying it is human.'
    const { model } = answering({ redLine: 'crossed' }, told)

    const judgement = await judgePlaybook(aPlaybook(), { store, model })

    if (judgement.kind !== 'rejected') throw new Error('expected a refusal')
    expect(written[0]?.reason).toContain('red-lines.md')
    expect(written[0]?.reason).not.toContain('human')
    expect(written[0]?.stages.redLine).toEqual({ outcome: 'crossed', reason: told })
    expect(judgement.reason).toBe(told)
  })

  it('hands a quality refusal back in words the author can act on', async () => {
    const { store, written } = recording()
    const told = 'Step two never says how the follower would know the reply was sent.'
    const { model, asked } = answering({ quality: 'unfollowable' }, told)

    const judgement = await judgePlaybook(aPlaybook(), { store, model })

    if (judgement.kind !== 'rejected') throw new Error('expected a refusal')
    expect(written[0]?.reason).toContain(told)
    expect(stagesAsked(asked)).toEqual(['redLine', 'quality'])
    expect(written[0]?.stages.quality).toEqual({ outcome: 'unfollowable', reason: told })
  })

  it('hands a confidentiality refusal back the same way', async () => {
    const { store, written } = recording()
    const told = 'Step one writes out the author’s own mailbox address.'
    const { model, asked } = answering({ confidentiality: 'overreaching' }, told)

    const judgement = await judgePlaybook(aPlaybook(), { store, model })

    if (judgement.kind !== 'rejected') throw new Error('expected a refusal')
    expect(written[0]?.reason).toContain(told)
    expect(stagesAsked(asked)).toEqual(['redLine', 'quality', 'confidentiality'])
    expect(written[0]?.stages.confidentiality).toEqual({ outcome: 'overreaching', reason: told })
  })

  /** A model that was unreachable has said nothing, and silence is not a refusal. */
  it('does not refuse a playbook because the model failed', async () => {
    const { store, written, publishedIds } = recording()
    const model: Model = {
      name: 'test-model',
      classify: async () => {
        throw new Error('the route is down')
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }

    const judgement = await judgePlaybook(aPlaybook(), { store, model })

    expect(judgement.kind).toBe('failed')
    expect(written).toHaveLength(0)
    expect(publishedIds).toHaveLength(0)
  })

  /** A verdict about text that has moved is dropped, and nothing is published. */
  it('publishes nothing when the record comes back stale', async () => {
    const { store, publishedIds } = recording([aPlaybook()], {
      record: async () => ({ outcome: 'stale' }),
    })
    const { model } = answering()

    expect(await judgePlaybook(aPlaybook(), { store, model })).toEqual({ kind: 'stale' })
    expect(publishedIds).toHaveLength(0)
  })

  it('records which model actually answered when a fallback took the call', async () => {
    const { store, written } = recording()
    const { model } = answering({}, 'fine', 'some-other/model')

    await judgePlaybook(aPlaybook(), { store, model })

    expect(written[0]?.model).toBe('some-other/model')
  })
})

/**
 * One pass over the queue (`#1219`).
 *
 * The counts are what a runner logs and what an operator reads, so `approved`
 * and `published` being separate numbers is a property rather than an
 * implementation detail: a playbook that cleared moderation and did not publish
 * is a citizen still waiting.
 */
describe('one pass over the playbook queue', () => {
  it('counts what it judged, approved and published', async () => {
    const { store } = recording([aPlaybook(), aPlaybook({ id: 'b', slug: 'another' })])
    const { model } = answering()

    expect(await playbookTick({ store, model }, 10)).toEqual({
      judged: 2,
      approved: 2,
      rejected: 0,
      failed: 0,
      published: 2,
      released: 0,
    })
  })

  it('separates a playbook that cleared moderation from one that reached the catalogue', async () => {
    const { store } = recording([aPlaybook()], {
      publish: async () => ({ outcome: 'not-in-review', status: 'draft' }),
    })
    const { model } = answering()

    const outcome = await playbookTick({ store, model }, 10)
    expect(outcome.approved).toBe(1)
    expect(outcome.published).toBe(0)
  })

  /**
   * The retry, and the reason it runs first: a playbook stranded between the
   * two writes has already waited a poll longer than the queue behind it, and
   * releasing it costs no model call.
   */
  it('releases a verdict an earlier pass recorded before it judges anything new', async () => {
    const { store, publishedIds } = recording([aPlaybook()], { cleared: ['stranded'] })
    const { model } = answering()

    const outcome = await playbookTick({ store, model }, 10)
    expect(outcome.released).toBe(1)
    expect(publishedIds[0]).toBe('stranded')
  })

  it('counts a failure without losing the rest of the batch', async () => {
    let calls = 0
    const model: Model = {
      name: 'test-model',
      classify: async (request) => {
        calls++
        if (calls === 1) throw new Error('the route is down')
        return {
          decision:
            request.system === PLAYBOOK_RED_LINE_PROMPT
              ? 'clear'
              : request.system === PLAYBOOK_QUALITY_PROMPT
                ? 'followable'
                : 'clean',
          reason: 'fine',
        }
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }
    const { store } = recording([aPlaybook(), aPlaybook({ id: 'b', slug: 'another' })])

    const outcome = await playbookTick({ store, model }, 10)
    expect(outcome.failed).toBe(1)
    expect(outcome.approved).toBe(1)
  })
})
