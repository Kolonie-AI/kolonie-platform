import { describe, expect, it } from 'vitest'
import { AccountKindSchema } from '@kolonie-ai/core'
import type {
  PendingPlaybookStepProposal,
  RecordPlaybookStepProposalVerdictInput,
} from '@kolonie-ai/db'
import { CONFIDENTIALITY_PROMPT } from './confidentiality.js'
import type { Model } from './llm.js'
import {
  A_PROPOSAL_NAMES_AN_ACCOUNT,
  A_PROPOSAL_POSITION_IS_UNREAL,
  PLAYBOOK_PROPOSAL_BATCH,
  judgePlaybookStepProposal,
  playbookProposalTick,
  proposalPositionIsReal,
  type PlaybookProposalModerationStore,
} from './playbooks.js'
import {
  PLAYBOOK_STEP_COHERENCE_PROMPT,
  PLAYBOOK_STEP_MERIT_PROMPT,
  playbookStepProposalRedLineRefusal,
} from './playbook-prompts.js'
import { RED_LINE_PROMPT } from './redline.js'

const aProposal = (
  overrides: Partial<PendingPlaybookStepProposal> = {},
): PendingPlaybookStepProposal => ({
  proposalId: '11111111-1111-4111-8111-111111111111',
  playbookId: '22222222-2222-4222-8222-222222222222',
  playbookTitle: 'Answer the week’s unanswered support tickets',
  playbookSummary: 'Read what nobody has answered and write one reply.',
  playbookVersion: 1,
  steps: [
    { title: 'Read the open tickets', usesSlots: ['mailbox'] },
    { title: 'Write one reply' },
    { title: 'Close the ticket' },
  ],
  requiredAccounts: [
    { slot: 'mailbox', kind: AccountKindSchema.parse('mailbox'), minProved: true },
  ],
  agentId: '33333333-3333-4333-8333-333333333333' as PendingPlaybookStepProposal['agentId'],
  kind: 'replace',
  position: 2,
  title: 'Write one careful reply',
  detail: 'Cover what you could not answer.',
  why: 'Step 2 points at a page that 404s and the next citizen will waste an attempt.',
  againstVersion: 1,
  createdAt: '2026-08-18T00:00:00.000Z',
  ...overrides,
})

/**
 * A model that answers each judgement in that judgement's own vocabulary.
 *
 * Keyed on the prompt rather than on call order: the four-stage order is
 * `#1254`'s decision and therefore under test.
 */
const answering = (
  verdicts: {
    readonly redLine?: 'clear' | 'crossed'
    readonly coherence?: 'coherent' | 'incoherent'
    readonly merit?: 'better' | 'not-better'
    readonly confidential?: readonly string[]
  } = {},
  reason = 'It names a slot the playbook does not declare.',
) => {
  const asked: { system: string; user: string }[] = []
  const model: Model = {
    name: 'test-model',
    classify: async (request) => {
      asked.push({ system: request.system, user: request.user })
      const decision =
        request.system === RED_LINE_PROMPT
          ? (verdicts.redLine ?? 'clear')
          : request.system === PLAYBOOK_STEP_COHERENCE_PROMPT
            ? (verdicts.coherence ?? 'coherent')
            : (verdicts.merit ?? 'better')
      return { decision, reason }
    },
    mark: async (request) => {
      asked.push({ system: request.system, user: request.user })
      return (verdicts.confidential ?? []).map((text) => ({ text, kind: 'address' as const }))
    },
    compose: async () => [],
    embed: async () => [],
  }
  return { model, asked }
}

const stagesAsked = (asked: readonly { system: string }[]): readonly string[] =>
  asked.map((one) =>
    one.system === RED_LINE_PROMPT
      ? 'redLine'
      : one.system === CONFIDENTIALITY_PROMPT
        ? 'scrub'
        : one.system === PLAYBOOK_STEP_COHERENCE_PROMPT
          ? 'coherence'
          : one.system === PLAYBOOK_STEP_MERIT_PROMPT
            ? 'merit'
            : 'some prompt this test does not know',
  )

const recording = (
  proposals: readonly PendingPlaybookStepProposal[] = [aProposal()],
  outcome: 'written' | 'stale' = 'written',
  superseded = 0,
) => {
  const written: RecordPlaybookStepProposalVerdictInput[] = []
  const store: PlaybookProposalModerationStore = {
    pending: async (limit) => proposals.slice(0, limit),
    record: async (input) => {
      written.push(input)
      return { outcome, superseded: input.decision === 'accepted' ? superseded : 0 }
    },
  }
  return { store, written }
}

describe('proposalPositionIsReal', () => {
  it('accepts replace and remove inside the pipeline', () => {
    expect(proposalPositionIsReal('replace', 1, 3)).toBe(true)
    expect(proposalPositionIsReal('remove', 3, 3)).toBe(true)
    expect(proposalPositionIsReal('replace', 4, 3)).toBe(false)
    expect(proposalPositionIsReal('remove', 0, 3)).toBe(false)
  })

  it('accepts insert-after from 0 through the last step', () => {
    expect(proposalPositionIsReal('insert-after', 0, 3)).toBe(true)
    expect(proposalPositionIsReal('insert-after', 3, 3)).toBe(true)
    expect(proposalPositionIsReal('insert-after', 4, 3)).toBe(false)
  })
})

describe('judgePlaybookStepProposal', () => {
  it('asks red lines, then the scrub, then coherence, then merit', async () => {
    const { model, asked } = answering()
    const { store, written } = recording()

    const judgement = await judgePlaybookStepProposal(aProposal(), { store, model })

    expect(stagesAsked(asked)).toEqual(['redLine', 'scrub', 'coherence', 'merit'])
    expect(judgement).toEqual({ kind: 'accepted', superseded: 0 })
    expect(written).toEqual([
      {
        proposalId: aProposal().proposalId,
        judged: {
          title: aProposal().title,
          detail: aProposal().detail,
          why: aProposal().why,
        },
        decision: 'accepted',
        title: aProposal().title,
        detail: aProposal().detail,
        why: aProposal().why,
      },
    ])
  })

  it('stops at the red line and asks nothing further', async () => {
    const { model, asked } = answering({ redLine: 'crossed' }, 'It asks for a token.')
    const { store, written } = recording()

    const judgement = await judgePlaybookStepProposal(aProposal(), { store, model })

    expect(stagesAsked(asked)).toEqual(['redLine'])
    expect(judgement).toEqual({
      kind: 'rejected',
      reason: playbookStepProposalRedLineRefusal(),
      redLine: true,
    })
    expect(written[0]?.decision).toBe('rejected')
  })

  it('refuses a proposal the scrub found an account in, without redacting', async () => {
    const title = 'Mail colette@example.test then reply'
    const { model, asked } = answering({ confidential: ['colette@example.test'] })
    const { store, written } = recording([aProposal({ title })])

    const judgement = await judgePlaybookStepProposal(aProposal({ title }), { store, model })

    expect(stagesAsked(asked)).toEqual(['redLine', 'scrub'])
    expect(judgement).toEqual({
      kind: 'rejected',
      reason: A_PROPOSAL_NAMES_AN_ACCOUNT,
      redLine: false,
    })
    expect(written[0]?.decision).toBe('rejected')
  })

  it('ignores a span the model paraphrased rather than found', async () => {
    const { model } = answering({ confidential: ['an address the proposal never contained'] })
    const { store } = recording()

    expect(await judgePlaybookStepProposal(aProposal(), { store, model })).toEqual({
      kind: 'accepted',
      superseded: 0,
    })
  })

  it('refuses an unreal position without asking coherence', async () => {
    const { model, asked } = answering()
    const { store, written } = recording([aProposal({ position: 99 })])

    const judgement = await judgePlaybookStepProposal(aProposal({ position: 99 }), {
      store,
      model,
    })

    expect(stagesAsked(asked)).toEqual(['redLine', 'scrub'])
    expect(judgement).toEqual({
      kind: 'rejected',
      reason: A_PROPOSAL_POSITION_IS_UNREAL,
      redLine: false,
    })
    expect(written[0]?.decision).toBe('rejected')
  })

  it('shows coherence the declared slots and refuses an incoherent proposal', async () => {
    const { model, asked } = answering(
      { coherence: 'incoherent' },
      'It names a trello slot the playbook does not declare.',
    )
    const { store, written } = recording()

    const judgement = await judgePlaybookStepProposal(aProposal(), { store, model })

    const coherence = asked.find((one) => one.system === PLAYBOOK_STEP_COHERENCE_PROMPT)
    expect(coherence?.user).toContain('mailbox')
    expect(coherence?.user).toContain('Declared account slots:')
    expect(judgement.kind).toBe('rejected')
    expect(written[0]?.decision).toBe('rejected')
  })

  it('accepts on merit with no claims present', async () => {
    const { model, asked } = answering()
    const { store } = recording()

    await judgePlaybookStepProposal(aProposal(), { store, model })

    const merit = asked.find((one) => one.system === PLAYBOOK_STEP_MERIT_PROMPT)
    expect(merit?.user).toContain('(none yet)')
    expect(merit?.user).toContain('Current step 2: Write one reply')
    expect(merit?.user).toContain(aProposal().why)
  })

  it('reports a proposal that moved under it as stale', async () => {
    const { model } = answering()
    const { store } = recording([aProposal()], 'stale')

    expect(await judgePlaybookStepProposal(aProposal(), { store, model })).toEqual({
      kind: 'stale',
    })
  })

  it('writes nothing when the model throws', async () => {
    const model: Model = {
      name: 'test-model',
      classify: async () => {
        throw new Error('the provider is unreachable')
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }
    const { store, written } = recording()

    const judgement = await judgePlaybookStepProposal(aProposal(), { store, model })

    expect(judgement.kind).toBe('failed')
    expect(written).toEqual([])
  })
})

describe('playbookProposalTick', () => {
  it('counts what it judged and accumulates superseded siblings', async () => {
    const { model } = answering()
    const { store } = recording(
      [aProposal(), aProposal({ proposalId: '44444444-4444-4444-8444-444444444444' })],
      'written',
      1,
    )

    expect(await playbookProposalTick({ store, model }, 100)).toEqual({
      judged: 2,
      accepted: 2,
      rejected: 0,
      superseded: 2,
      failed: 0,
    })
  })

  it('takes no more than the batch and never more than PLAYBOOK_PROPOSAL_BATCH', async () => {
    const { model } = answering()
    const many = Array.from({ length: 3 }, (_, n) =>
      aProposal({ proposalId: `44444444-4444-4444-8444-44444444444${n}` }),
    )
    const { store } = recording(many)

    expect((await playbookProposalTick({ store, model }, 1)).judged).toBe(1)
    expect(PLAYBOOK_PROPOSAL_BATCH).toBe(100)
    expect((await playbookProposalTick({ store, model }, 500)).judged).toBe(3)
  })
})
