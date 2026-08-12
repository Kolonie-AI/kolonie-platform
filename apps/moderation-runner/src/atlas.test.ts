import { describe, expect, it } from 'vitest'
import { MODERATION_STAGE_NOT_RUN, questionById, type AtlasProposal } from '@kolonie-ai/core'
import type { Model } from './llm.js'
import { atlasTick, judgeProposal, type AtlasModerationStore } from './atlas.js'
import {
  ATLAS_AGENT_API_PROMPT,
  ATLAS_AGENT_CAN_HOLD_PROMPT,
  ATLAS_RED_LINE_PROMPT,
  ATLAS_SIGNUP_WALKABLE_PROMPT,
} from './atlas-prompts.js'

const aProposal = (over: Partial<AtlasProposal> = {}): AtlasProposal =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'clawhub.com',
    source: 'citizen',
    why: 'I needed somewhere to publish a package and had nowhere.',
    status: 'pending',
    decidedReason: null,
    mergedInto: null,
    proposedAt: '2026-08-12T00:00:00.000Z',
    decidedAt: null,
    ...over,
  }) as AtlasProposal

/**
 * A model that answers each question in that question's own vocabulary.
 *
 * **Keyed on the prompt rather than on call order**, for the reason the quest
 * pass's fake gives: the order is part of what is under test, and a fake that
 * answered the third call `none` regardless of which question it was would pass
 * a pipeline that asked them backwards.
 */
const answering = (
  verdicts: {
    readonly redLine?: 'clear' | 'crossed'
    readonly agentCanHold?: 'yes' | 'no' | 'unknown'
    readonly agentApi?: 'full' | 'partial' | 'none' | 'unknown'
    readonly signupWalkable?: 'yes' | 'no' | 'unknown'
    readonly shelf?: string
  } = {},
  reason = 'Its own documentation says so.',
) => {
  const asked: { system: string; user: string }[] = []
  const model: Model = {
    name: 'test-model',
    classify: async (request) => {
      asked.push({ system: request.system, user: request.user })

      const decision =
        request.system === ATLAS_RED_LINE_PROMPT
          ? (verdicts.redLine ?? 'clear')
          : request.system === ATLAS_AGENT_CAN_HOLD_PROMPT
            ? (verdicts.agentCanHold ?? 'yes')
            : request.system === ATLAS_AGENT_API_PROMPT
              ? (verdicts.agentApi ?? 'full')
              : request.system === ATLAS_SIGNUP_WALKABLE_PROMPT
                ? (verdicts.signupWalkable ?? 'yes')
                : (verdicts.shelf ?? 'code-hosting')

      return { decision, reason }
    },
    mark: async () => [],
    compose: async () => [],
    embed: async () => [],
  }

  return { model, asked }
}

/** A store that records what it was told to do rather than doing it. */
const recording = (over: { readonly listed?: string; readonly stale?: boolean } = {}) => {
  const written: Parameters<AtlasModerationStore['record']>[0][] = []
  const store: AtlasModerationStore = {
    pending: async () => [aProposal()],
    listed: async () => over.listed,
    record: async (input) => {
      written.push(input)
      return { outcome: over.stale === true ? 'stale' : 'written' }
    },
  }

  return { store, written }
}

describe('the Colony judging a proposed provider', () => {
  it('lists one that clears every question, on the shelf it chose', async () => {
    const { model, asked } = answering({ shelf: 'code-hosting' })
    const { store, written } = recording()

    const judgement = await judgeProposal(aProposal(), { store, model })

    expect(judgement).toEqual({ kind: 'accepted', category: 'code-hosting' })
    /** Five questions asked, in the order they are worth asking. */
    expect(asked).toHaveLength(5)
    expect(written[0]).toMatchObject({ decision: 'accepted', category: 'code-hosting' })
    expect(written[0]?.model).toBe('test-model')
  })

  /**
   * `#680`'s failure, as a test: *a proposal that fails question two being
   * accepted and left, because the person reviewing it was never asked question
   * two.* Every question is asked on every proposal, so it cannot recur.
   */
  it.each([
    ['agent-can-hold' as const, { agentCanHold: 'no' as const }],
    ['agent-usable-api' as const, { agentApi: 'none' as const }],
    ['signup-walkable' as const, { signupWalkable: 'no' as const }],
  ])('refuses on %s with that question’s own written sentence', async (id, verdicts) => {
    const { model } = answering(verdicts)
    const { store, written } = recording()

    const judgement = await judgeProposal(aProposal(), { store, model })

    expect(judgement).toEqual({ kind: 'refused', reason: questionById(id).refusal })
    expect(written[0]?.decision).toBe('refused')
  })

  /**
   * An unanswered question is not a failed one. `atlasAdmissionRefusal` draws
   * that line for a human proposer and it holds for the model: refusing an
   * honest *I do not know* is what teaches the next reader to guess yes.
   */
  it('lists a provider whose questions it could not answer', async () => {
    const { model } = answering({
      agentCanHold: 'unknown',
      agentApi: 'unknown',
      signupWalkable: 'unknown',
    })
    const { store, written } = recording()

    const judgement = await judgeProposal(aProposal(), { store, model })

    expect(judgement.kind).toBe('accepted')
    expect(written[0]?.stages.agentApi.outcome).toBe('unknown')
  })

  it('refuses a red line without paying for the questions behind it', async () => {
    const { model, asked } = answering({ redLine: 'crossed' })
    const { store, written } = recording()

    const judgement = await judgeProposal(aProposal(), { store, model })

    expect(judgement.kind).toBe('refused')
    expect(asked).toHaveLength(1)
    /** Named to nobody: a refusal that said which rule teaches somebody probing. */
    expect(judgement.kind === 'refused' && judgement.reason).not.toContain('captcha')
    expect(written[0]?.stages.agentCanHold.outcome).toBe(MODERATION_STAGE_NOT_RUN)
    /** The reason the model gave is kept on the row even though nobody is shown it. */
    expect(written[0]?.stages.redLine.reason).toBe('Its own documentation says so.')
  })

  it('merges a provider the catalogue already holds, and asks nothing', async () => {
    const { model, asked } = answering()
    const { store, written } = recording({ listed: 'clawhub.com' })

    const judgement = await judgeProposal(aProposal(), { store, model })

    expect(judgement).toEqual({ kind: 'merged', into: 'clawhub.com' })
    expect(asked).toHaveLength(0)
    expect(written[0]?.stages.redLine.outcome).toBe(MODERATION_STAGE_NOT_RUN)
  })

  /**
   * The clause the whole design rests on: an unreachable model leaves the
   * proposal pending. Not listed, not refused, retried on the next tick — and
   * nothing recorded, so there is no half verdict to reconcile.
   */
  it('records nothing when a stage throws', async () => {
    const model: Model = {
      name: 'test-model',
      classify: async () => {
        throw new Error('the gateway did not answer')
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }
    const { store, written } = recording()

    const judgement = await judgeProposal(aProposal(), { store, model })

    expect(judgement.kind).toBe('failed')
    expect(written).toHaveLength(0)
  })

  /** Somebody decided it while the model was thinking. One row, one decision. */
  it('reports a proposal decided under it as stale', async () => {
    const { model } = answering()
    const { store } = recording({ stale: true })

    expect((await judgeProposal(aProposal(), { store, model })).kind).toBe('stale')
  })

  it('counts a pass over the queue', async () => {
    const { model } = answering()
    const { store } = recording()

    expect(await atlasTick({ store, model }, 10)).toEqual({
      judged: 1,
      accepted: 1,
      refused: 0,
      merged: 0,
      failed: 0,
    })
  })
})
