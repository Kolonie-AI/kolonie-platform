import { describe, expect, it } from 'vitest'
import type { SubmissionId, TaskId, Timestamp } from '@kolonie-ai/core'
import type { AuditCandidate, AuditRecordOutcome } from '@kolonie-ai/db'
import type { Model } from './llm.js'
import {
  AUDIT_CHOICES,
  QUEST_AUDIT_PROMPT,
  auditQuestVerdict,
  questAuditTick,
  type QuestAuditStore,
} from './quest-audit.js'

const aCandidate = (overrides: Partial<AuditCandidate> = {}): AuditCandidate => ({
  submissionId: '11111111-1111-4111-8111-111111111111' as SubmissionId,
  taskId: '22222222-2222-4222-8222-222222222222' as TaskId,
  questTitle: 'Name a provider that refused an agent signup',
  questions: [
    {
      key: 'provider',
      prompt: 'Which provider refused you?',
      criteria: 'A hostname, not a sentence.',
      required: true,
      minLength: 0,
      maxLength: 500,
    },
    { key: 'aside', prompt: 'Anything else?', required: false, minLength: 0, maxLength: 500 },
  ],
  answers: [{ questionKey: 'provider', text: 'mail.example refused at the signup form.' }],
  verdict: 'It names a provider and says where the refusal happened.',
  acceptedAt: '2026-08-15T09:00:00.000Z' as Timestamp,
  ...overrides,
})

const model = (options: {
  readonly decision?: (typeof AUDIT_CHOICES)[number] | string
  readonly reason?: string
  readonly throws?: boolean
}) => {
  const asked: { system: string; user: string; choices: readonly string[] }[] = []
  const impl: Model = {
    name: 'audit-model',
    classify: async (request) => {
      asked.push({ system: request.system, user: request.user, choices: request.choices })
      if (options.throws === true) throw new Error('the gateway did not answer')
      return {
        decision: options.decision ?? 'stands',
        reason: options.reason ?? 'The required question was answered with a hostname.',
      }
    },
    mark: async () => [],
    compose: async () => [],
    embed: async () => [],
  }
  return { model: impl, asked }
}

const recording = (
  candidates: readonly AuditCandidate[] = [aCandidate()],
  outcome: AuditRecordOutcome['outcome'] = 'recorded',
) => {
  const written: { submissionId: string; agrees: boolean; reason: string }[] = []

  const store: QuestAuditStore = {
    queue: async () => candidates,
    record: async (input) => {
      written.push({ ...input })
      return { outcome } as AuditRecordOutcome
    },
  }

  return { store, written }
}

/**
 * The second reading of a verdict the judge passed (`#221`, `#944`).
 *
 * The property under test is the one that separates this pass from
 * `redline-review.ts`: **nobody is waiting, so every doubt records nothing.**
 * There the citizen's attempt is held and a stuck gateway must release it; here
 * the citizen was paid at the verdict, and a row written on an unclear reading
 * would tilt the Colony's measurement of its own judge towards *the judge is
 * fine* — the direction that keeps money moving.
 */
describe('reading a passed verdict a second time', () => {
  it('records agreement when the attack on the acceptance fails', async () => {
    const { store, written } = recording()
    const { model: impl } = model({ decision: 'stands', reason: 'The hostname is right there.' })

    const judgement = await auditQuestVerdict(aCandidate(), { store, model: impl })

    expect(judgement).toEqual({ kind: 'agreed' })
    expect(written).toEqual([
      {
        submissionId: '11111111-1111-4111-8111-111111111111',
        agrees: true,
        reason: 'The hostname is right there.',
      },
    ])
  })

  it('records disagreement when the reading finds the question unanswered', async () => {
    const { store, written } = recording()
    const { model: impl } = model({
      decision: 'should-not-have-passed',
      reason: 'It names no provider at all, only that a signup was attempted.',
    })

    const judgement = await auditQuestVerdict(aCandidate(), { store, model: impl })

    expect(judgement).toEqual({ kind: 'disagreed' })
    expect(written[0]?.agrees).toBe(false)
  })

  it('writes nothing when the reader will not commit either way', async () => {
    const { store, written } = recording()
    const { model: impl } = model({ decision: 'cannot-tell' })

    const judgement = await auditQuestVerdict(aCandidate(), { store, model: impl })

    expect(judgement).toEqual({ kind: 'unread', cause: 'undecided' })
    expect(written).toHaveLength(0)
  })

  it('writes nothing when the model cannot be reached', async () => {
    const { store, written } = recording()
    const { model: impl } = model({ throws: true })

    const judgement = await auditQuestVerdict(aCandidate(), { store, model: impl })

    expect(judgement).toEqual({ kind: 'unread', cause: 'unreachable' })
    expect(written).toHaveLength(0)
  })

  it('writes nothing when the answer is not one of the three verdicts', async () => {
    const { store, written } = recording()
    const { model: impl } = model({ decision: 'probably-fine' })

    const judgement = await auditQuestVerdict(aCandidate(), { store, model: impl })

    expect(judgement).toEqual({ kind: 'unread', cause: 'unreadable' })
    expect(written).toHaveLength(0)
  })

  /**
   * `quest_audits_reason_length` is a check constraint between 10 and 1000
   * characters, written for a steward typing a sentence. A classifier answering
   * `"ok"` would fail it, and a failed insert mid-batch throws on every
   * candidate behind it.
   */
  it('replaces a reason too short for the column rather than failing the insert', async () => {
    const { store, written } = recording()
    const { model: impl } = model({ decision: 'stands', reason: 'ok' })

    await auditQuestVerdict(aCandidate(), { store, model: impl })

    expect(written[0]?.reason.length).toBeGreaterThanOrEqual(10)
    expect(written[0]?.reason).toContain('stands')
  })

  it('bounds a reason longer than the column allows', async () => {
    const { store, written } = recording()
    const { model: impl } = model({ reason: 'x'.repeat(2000) })

    await auditQuestVerdict(aCandidate(), { store, model: impl })

    expect(written[0]?.reason).toHaveLength(1000)
    expect(written[0]?.reason.endsWith('…')).toBe(true)
  })

  /** Read between the draw and the write. Nothing is counted for either side. */
  it('reports a stale candidate when the row was audited first', async () => {
    const { store } = recording([aCandidate()], 'already-audited')
    const { model: impl } = model({})

    const judgement = await auditQuestVerdict(aCandidate(), { store, model: impl })

    expect(judgement).toEqual({ kind: 'stale' })
  })

  /**
   * The brief is an attack rather than a check, so what it is shown has to be
   * the judge's own reasoning — a reader given only the answer would be
   * re-judging rather than auditing.
   */
  it('shows the reader the questions, the answers and the judge’s reason', async () => {
    const { store } = recording()
    const { model: impl, asked } = model({})

    await auditQuestVerdict(aCandidate(), { store, model: impl })

    expect(asked).toHaveLength(1)
    expect(asked[0]?.system).toBe(QUEST_AUDIT_PROMPT)
    expect(asked[0]?.user).toContain('Which provider refused you?')
    expect(asked[0]?.user).toContain('mail.example refused at the signup form.')
    expect(asked[0]?.user).toContain('It names a provider and says where the refusal happened.')
    expect(asked[0]?.user).toContain('what the sponsor said a good answer does:')
    expect(asked[0]?.user).toContain('aside (optional)')
    expect(asked[0]?.choices).toEqual([...AUDIT_CHOICES])
  })

  /**
   * `#177` keeps the judge blind, and an auditor with more context than the
   * judge is not auditing the judge. The shape carries no agent id, and nothing
   * here may reintroduce one.
   */
  it('never shows the reader who wrote the answer', async () => {
    const { store } = recording()
    const { model: impl, asked } = model({})

    await auditQuestVerdict(aCandidate(), { store, model: impl })

    expect(asked[0]?.user).not.toContain('11111111-1111-4111-8111-111111111111')
    expect(asked[0]?.user).not.toContain('22222222-2222-4222-8222-222222222222')
  })
})

describe('one pass over the audit queue', () => {
  it('counts each reading under the heading it landed on', async () => {
    const candidates = [
      aCandidate(),
      aCandidate({ submissionId: '33333333-3333-4333-8333-333333333333' as SubmissionId }),
    ]
    const { store, written } = recording(candidates)
    const { model: impl } = model({ decision: 'should-not-have-passed' })

    const outcome = await questAuditTick({ store, model: impl }, 10)

    expect(outcome).toEqual({ read: 2, agreed: 0, disagreed: 2, unread: 0, stale: 0 })
    expect(written).toHaveLength(2)
  })

  it('is a no-op on an empty queue', async () => {
    const { store } = recording([])
    const { model: impl, asked } = model({})

    const outcome = await questAuditTick({ store, model: impl }, 10)

    expect(outcome).toEqual({ read: 0, agreed: 0, disagreed: 0, unread: 0, stale: 0 })
    expect(asked).toHaveLength(0)
  })

  /**
   * A gateway that is down must not look like a judge that is never wrong: the
   * candidates stay drawable and the pass says how many it could not read.
   */
  it('leaves an unreachable batch entirely unwritten', async () => {
    const { store, written } = recording([aCandidate(), aCandidate()])
    const { model: impl } = model({ throws: true })

    const outcome = await questAuditTick({ store, model: impl }, 10)

    expect(outcome).toEqual({ read: 2, agreed: 0, disagreed: 0, unread: 2, stale: 0 })
    expect(written).toHaveLength(0)
  })
})
