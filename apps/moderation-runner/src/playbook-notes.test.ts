import { describe, expect, it } from 'vitest'
import { PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH } from '@kolonie-ai/core'
import type { PendingPlaybookNote, RecordPlaybookNoteVerdictInput } from '@kolonie-ai/db'
import { REDACTION } from './answers.js'
import { CONFIDENTIALITY_PROMPT } from './confidentiality.js'
import type { Model } from './llm.js'
import {
  judgePlaybookNote,
  NOTHING_SURVIVED_THE_SCRUB,
  playbookNoteTick,
  shortenToBound,
  type PlaybookNoteModerationStore,
} from './playbooks.js'
import { PLAYBOOK_NOTE_QUALITY_PROMPT } from './quality.js'
import { RED_LINE_PROMPT } from './redline.js'

const aNote = (overrides: Partial<PendingPlaybookNote> = {}): PendingPlaybookNote => ({
  runId: '33333333-3333-4333-8333-333333333333',
  playbookId: '22222222-2222-4222-8222-222222222222',
  playbookTitle: 'Answer the week’s unanswered support tickets',
  playbookSummary: 'Read what nobody has answered and write one reply.',
  outcome: 'completed',
  note: 'Step 3 wants a card before the trial starts, not after — budget for it.',
  ...overrides,
})

/**
 * A model that answers each judgement in that judgement's own vocabulary.
 *
 * Keyed on the prompt rather than on call order, as the playbook fake is: the
 * order of the three is `#1246`'s decision and therefore under test, and a fake
 * that answered the second call `reject` whatever it was sent would pass a
 * pipeline that ran them backwards.
 */
const answering = (
  verdicts: {
    readonly redLine?: 'clear' | 'crossed'
    readonly quality?: 'approve' | 'reject' | 'abusive'
    readonly confidential?: readonly string[]
  } = {},
  reason = 'It names an address of the author’s own and nothing about the run.',
) => {
  const asked: { system: string; user: string }[] = []
  const model: Model = {
    name: 'test-model',
    classify: async (request) => {
      asked.push({ system: request.system, user: request.user })
      const decision =
        request.system === RED_LINE_PROMPT
          ? (verdicts.redLine ?? 'clear')
          : (verdicts.quality ?? 'approve')
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

/** Which judgement each call was, read back off the prompt it was sent. */
const stagesAsked = (asked: readonly { system: string }[]): readonly string[] =>
  asked.map((one) =>
    one.system === RED_LINE_PROMPT
      ? 'redLine'
      : one.system === CONFIDENTIALITY_PROMPT
        ? 'scrub'
        : one.system === PLAYBOOK_NOTE_QUALITY_PROMPT
          ? 'quality'
          : 'some prompt this test does not know',
  )

const recording = (
  notes: readonly PendingPlaybookNote[] = [aNote()],
  outcome: 'written' | 'stale' = 'written',
) => {
  const written: RecordPlaybookNoteVerdictInput[] = []
  const store: PlaybookNoteModerationStore = {
    pending: async (limit) => notes.slice(0, limit),
    record: async (input) => {
      written.push(input)
      return { outcome }
    },
  }
  return { store, written }
}

describe('judgePlaybookNote', () => {
  it('asks red lines, then the scrub, then quality', async () => {
    const { model, asked } = answering()
    const { store, written } = recording()

    const judgement = await judgePlaybookNote(aNote(), { store, model })

    expect(stagesAsked(asked)).toEqual(['redLine', 'scrub', 'quality'])
    expect(judgement).toEqual({ kind: 'approved', published: aNote().note })
    expect(written).toEqual([
      {
        runId: aNote().runId,
        judged: aNote().note,
        decision: 'approved',
        published: aNote().note,
      },
    ])
  })

  it('stops at the red line and asks nothing further', async () => {
    const { model, asked } = answering({ redLine: 'crossed' }, 'It asks the reader for a token.')
    const { store, written } = recording()

    const judgement = await judgePlaybookNote(aNote(), { store, model })

    expect(stagesAsked(asked)).toEqual(['redLine'])
    expect(judgement).toMatchObject({ kind: 'rejected' })
    expect(judgement.kind === 'rejected' && judgement.reason).toContain('Judged abusive')
    expect(judgement.kind === 'rejected' && judgement.reason).toContain(
      'It asks the reader for a token.',
    )
    expect(written[0]).toMatchObject({ decision: 'rejected', refusal: 'abusive' })
  })

  it('records a quality abusive refusal on the abusive arm', async () => {
    const { model, asked } = answering(
      { quality: 'abusive' },
      'It is an off-platform lure, not a note about the run.',
    )
    const { store, written } = recording()

    const judgement = await judgePlaybookNote(aNote(), { store, model })

    expect(stagesAsked(asked)).toEqual(['redLine', 'scrub', 'quality'])
    expect(judgement).toMatchObject({ kind: 'rejected' })
    expect(judgement.kind === 'rejected' && judgement.reason).toContain('Judged abusive')
    expect(written[0]).toMatchObject({ decision: 'rejected', refusal: 'abusive' })
  })

  it('publishes the author’s words with the confidential spans taken out', async () => {
    const note = 'Signed up as colette@example.test and step 3 wanted a card before the trial.'
    const { model } = answering({ confidential: ['colette@example.test'] })
    const { store, written } = recording([aNote({ note })])

    const judgement = await judgePlaybookNote(aNote({ note }), { store, model })

    expect(judgement).toEqual({
      kind: 'approved',
      published: `Signed up as ${REDACTION} and step 3 wanted a card before the trial.`,
    })
    expect(written[0]).toMatchObject({ decision: 'approved', judged: note })
  })

  it('ignores a span the model paraphrased rather than found', async () => {
    const { model } = answering({ confidential: ['an address the note never contained'] })
    const { store } = recording()

    const judgement = await judgePlaybookNote(aNote(), { store, model })

    expect(judgement).toEqual({ kind: 'approved', published: aNote().note })
  })

  it('rejects the note the scrub left nothing of, without asking quality', async () => {
    const note = 'colette@example.test — that is the mailbox I used, nothing else to add.'
    const { model, asked } = answering({
      confidential: ['colette@example.test', 'that is the mailbox I used, nothing else to add'],
    })
    const { store, written } = recording([aNote({ note })])

    const judgement = await judgePlaybookNote(aNote({ note }), { store, model })

    expect(stagesAsked(asked)).toEqual(['redLine', 'scrub'])
    expect(judgement).toEqual({ kind: 'rejected', reason: NOTHING_SURVIVED_THE_SCRUB })
    expect(written[0]?.decision).toBe('rejected')
  })

  it('judges quality against what would be published, not what was written', async () => {
    const note = 'Blocked at colette@example.test — the provider would not send the code.'
    const { model, asked } = answering({ confidential: ['colette@example.test'] })
    const { store } = recording([aNote({ note, outcome: 'blocked' })])

    await judgePlaybookNote(aNote({ note, outcome: 'blocked' }), { store, model })

    const quality = asked.find((one) => one.system === PLAYBOOK_NOTE_QUALITY_PROMPT)
    expect(quality?.user).toContain(REDACTION)
    expect(quality?.user).not.toContain('colette@example.test')
    expect(quality?.user).toContain('How this run ended: blocked')
  })

  it('reports a note that moved under it as stale rather than as a verdict', async () => {
    const { model } = answering()
    const { store } = recording([aNote()], 'stale')

    expect(await judgePlaybookNote(aNote(), { store, model })).toEqual({ kind: 'stale' })
  })

  it('writes nothing when the model throws, so the next pass sees it again', async () => {
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

    const judgement = await judgePlaybookNote(aNote(), { store, model })

    expect(judgement.kind).toBe('failed')
    expect(written).toEqual([])
  })
})

describe('shortenToBound', () => {
  const bound = PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH

  it('leaves a note inside the bound exactly as it was', () => {
    expect(shortenToBound('  Step 3 wants a card before the trial starts.  ')).toBe(
      'Step 3 wants a card before the trial starts.',
    )
  })

  it('cuts at the last sentence that fits', () => {
    const first = `Step 3 wants a card. ${'x'.repeat(bound - 40)} ends here.`
    const long = `${first} And this last sentence is over the bound.`

    const cut = shortenToBound(long)

    expect(cut).toBe(first)
    expect(cut!.length).toBeLessThanOrEqual(bound)
  })

  it('falls back to a word boundary when there is no sentence to cut at', () => {
    const words = 'card '.repeat(200).trim()

    const cut = shortenToBound(words)

    expect(cut!.length).toBeLessThanOrEqual(bound)
    expect(cut!.endsWith('card')).toBe(true)
  })

  it('refuses what is left when the scrub took nearly all of it', () => {
    expect(shortenToBound(`${REDACTION} and`)).toBeUndefined()
  })
})

describe('playbookNoteTick', () => {
  it('counts what it judged and leaves a stale note out of the tally', async () => {
    const { model } = answering()
    const { store } = recording([aNote(), aNote({ runId: '44444444-4444-4444-8444-444444444444' })])

    expect(await playbookNoteTick({ store, model }, 100)).toEqual({
      judged: 2,
      approved: 2,
      rejected: 0,
      failed: 0,
    })
  })

  it('takes no more than the batch it was given', async () => {
    const { model } = answering()
    const { store } = recording([aNote(), aNote({ runId: '44444444-4444-4444-8444-444444444444' })])

    expect((await playbookNoteTick({ store, model }, 1)).judged).toBe(1)
  })
})
