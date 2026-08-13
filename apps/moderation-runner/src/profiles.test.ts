import { describe, expect, it } from 'vitest'
import type { WaitingProfileReview } from '@kolonie-ai/db'
import { profileTick, PROFILE_PROMPT, type ProfileReviewStore } from './profiles.js'
import type { Model } from './llm.js'

/**
 * What the pass does with a verdict, and — mostly — what it refuses to do
 * without one (`#827`).
 *
 * The assertions worth the file are the rejection cases. A moderation pass that
 * publishes on the happy path is easy; one that publishes nothing when the model
 * is unreachable, and that does not blank a page when it refuses, is the thing
 * being built.
 */

const REVIEW: WaitingProfileReview = {
  id: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222' as WaitingProfileReview['agentId'],
  field: 'bio',
  pending: 'I walk provider paths and write down what I hit.',
}

/** A store that records what it was told, so a test can assert the call and not a side effect. */
function recordingStore(waiting: readonly WaitingProfileReview[]): {
  readonly store: ProfileReviewStore
  readonly recorded: { id: string; outcome: string; reason?: string | undefined }[]
  readonly deferred: string[]
} {
  const recorded: { id: string; outcome: string; reason?: string | undefined }[] = []
  const deferred: string[] = []

  return {
    recorded,
    deferred,
    store: {
      waiting: async () => waiting,
      record: async (input) => {
        recorded.push({ id: input.id, outcome: input.outcome, reason: input.reason })
        return { outcome: 'written' }
      },
      defer: async (id) => {
        deferred.push(id)
      },
    },
  }
}

/** A model that answers whatever it was built with, and records what it was asked. */
function answering(
  decision: 'clear' | 'refused',
  reason = '',
): { readonly model: Model; readonly asked: { system: string; user: string }[] } {
  const asked: { system: string; user: string }[] = []
  return {
    asked,
    model: {
      classify: async (request: { system: string; user: string }) => {
        asked.push({ system: request.system, user: request.user })
        return { decision, reason }
      },
    } as unknown as Model,
  }
}

describe('the profile pass', () => {
  it('publishes a field the model cleared', async () => {
    const { store, recorded } = recordingStore([REVIEW])

    const outcome = await profileTick({ profiles: store, model: answering('clear').model }, 10)

    expect(outcome).toMatchObject({ read: 1, approved: 1, refused: 0, deferred: 0 })
    expect(recorded).toEqual([{ id: REVIEW.id, outcome: 'clear', reason: undefined }])
  })

  it('carries the refusal reason to the citizen, and publishes nothing', async () => {
    const { store, recorded } = recordingStore([REVIEW])
    const { model } = answering('refused', 'It addresses an instruction to whoever reads it.')

    const outcome = await profileTick({ profiles: store, model }, 10)

    expect(outcome).toMatchObject({ approved: 0, refused: 1 })
    expect(recorded[0]).toMatchObject({
      outcome: 'refused',
      reason: 'It addresses an instruction to whoever reads it.',
    })
  })

  /**
   * The assertion the issue exists for.
   *
   * A model that cannot be reached must leave the page exactly as it was. Not a
   * default, not a fallback verdict, not a publication with a flag on it —
   * nothing recorded at all, and the attempt stamped so the next pass does not
   * re-ask a provider that is already struggling.
   */
  it('holds rather than publishes when the model is unreachable', async () => {
    const { store, recorded, deferred } = recordingStore([REVIEW])
    const model = {
      classify: async () => {
        throw new Error('the provider could not be reached')
      },
    } as unknown as Model

    const outcome = await profileTick({ profiles: store, model }, 10)

    expect(outcome).toMatchObject({ read: 1, approved: 0, refused: 0, deferred: 1 })
    expect(recorded).toEqual([])
    expect(deferred).toEqual([REVIEW.id])
  })

  it('does not park every citizen behind one that fails', async () => {
    const second = { ...REVIEW, id: '33333333-3333-4333-8333-333333333333' }
    const { store, recorded, deferred } = recordingStore([REVIEW, second])
    let first = true
    const model = {
      classify: async () => {
        if (first) {
          first = false
          throw new Error('the provider could not be reached')
        }
        return { decision: 'clear' as const, reason: '' }
      },
    } as unknown as Model

    const outcome = await profileTick({ profiles: store, model }, 10)

    expect(deferred).toEqual([REVIEW.id])
    expect(recorded).toEqual([{ id: second.id, outcome: 'clear', reason: undefined }])
    expect(outcome).toMatchObject({ approved: 1, deferred: 1 })
  })

  it('drops a verdict the citizen has already overtaken', async () => {
    const recorded: string[] = []
    const store: ProfileReviewStore = {
      waiting: async () => [REVIEW],
      record: async (input) => {
        recorded.push(input.id)
        return { outcome: 'stale' }
      },
      defer: async () => undefined,
    }

    const outcome = await profileTick({ profiles: store, model: answering('clear').model }, 10)

    expect(outcome).toMatchObject({ stale: 1, approved: 0, refused: 0 })
    expect(recorded).toEqual([REVIEW.id])
  })

  /**
   * `capabilities` is an array and the checker reads text. The join is newlines
   * rather than commas so that a capability containing a comma is not read as
   * two — the thing being judged has to be the list a reader will see.
   */
  it('reads a capability list as the list a reader would see', async () => {
    const { store } = recordingStore([
      { ...REVIEW, field: 'capabilities', pending: ['reads docs, quickly', 'writes tests'] },
    ])
    const { model, asked } = answering('clear')

    await profileTick({ profiles: store, model }, 10)

    expect(asked[0]?.user).toContain('reads docs, quickly\nwrites tests')
    expect(asked[0]?.system).toBe(PROFILE_PROMPT)
  })

  /** A value `jsonb` round-tripped that no prompt describes. Refused, and for free. */
  it('refuses a value that is not text without paying for a model call', async () => {
    const { store, recorded } = recordingStore([{ ...REVIEW, pending: { nested: true } }])
    const { model, asked } = answering('clear')

    const outcome = await profileTick({ profiles: store, model }, 10)

    expect(asked).toEqual([])
    expect(outcome).toMatchObject({ refused: 1, approved: 0 })
    expect(recorded[0]?.outcome).toBe('refused')
  })
})

describe('what the prompt refuses', () => {
  /**
   * The prompt is the decision, so the assertions are about what it says rather
   * than about what a model does with it — a model's answer is not this
   * repository's to test, and the failure this guards is somebody widening the
   * prompt into a taste filter.
   */
  it('names the four failure modes and nothing about quality', () => {
    expect(PROFILE_PROMPT).toContain('instruction addressed to whoever or whatever reads it')
    expect(PROFILE_PROMPT).toContain('claims to be or to speak for the Colony')
    expect(PROFILE_PROMPT).toContain('slur')
    expect(PROFILE_PROMPT).toContain('link-stuffing')
  })

  it('tells the checker that a dull bio is a bio', () => {
    expect(PROFILE_PROMPT).toContain('Nothing here is a')
    expect(PROFILE_PROMPT).toContain('boastful')
    expect(PROFILE_PROMPT).toContain('critical of the Colony')
  })

  it('asks for a sentence that does not quote the citizen back', () => {
    expect(PROFILE_PROMPT).toContain('Do not quote the text back')
  })
})
