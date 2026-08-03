import { describe, expect, it } from 'vitest'
import {
  TaskTypeSchema,
  type QuestQuestion,
  type Submission,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'
import {
  QuestReportVerifier,
  questJudgePrompt,
  type QuestDefinition,
  type QuestJudge,
  type QuestReports,
  type ScrubbedAnswer,
} from './quest-report.js'

const QUESTIONS: readonly QuestQuestion[] = [
  {
    key: 'what-happened',
    prompt: 'What happened when you registered?',
    criteria: 'Must be in English and say something specific about the signup.',
    required: true,
    minLength: 20,
    maxLength: 500,
  },
  {
    key: 'address',
    prompt: 'Which address did you register with?',
    required: true,
    minLength: 5,
    maxLength: 200,
    format: 'email',
  },
]

const ANSWERS: readonly ScrubbedAnswer[] = [
  { questionKey: 'address', text: '[removed]' },
  {
    questionKey: 'what-happened',
    text: 'The signup took two tries; the first form lost my input.',
  },
]

const aSubmission = (): Submission =>
  ({
    id: '33333333-3333-4333-8333-333333333333',
    taskId: '44444444-4444-4444-8444-444444444444',
    agentId: '55555555-5555-4555-8555-555555555555',
    attempt: 1,
    payload: {},
    status: 'verifying',
    submittedAt: '2026-08-03T12:00:00.000Z',
  }) as unknown as Submission

const aContext = (): VerificationContext =>
  ({ agent: { id: '55555555-5555-4555-8555-555555555555' } }) as unknown as VerificationContext

const aQuest = (overrides: Partial<QuestDefinition> = {}): QuestDefinition => ({
  title: 'A thousand registrations',
  instructions: 'Register and report.',
  questions: QUESTIONS,
  proofVerifier: null,
  ...overrides,
})

const reports = (options: {
  readonly quest?: QuestDefinition | null
  readonly scrubbed?: readonly ScrubbedAnswer[] | null
}): QuestReports => ({
  definition: async () => (options.quest === undefined ? aQuest() : options.quest),
  scrubbed: async () => (options.scrubbed === undefined ? ANSWERS : options.scrubbed),
})

const judging = (judgement: { pass: boolean; reason: string } | null) => {
  const asked: { questions: readonly QuestQuestion[]; answers: readonly ScrubbedAnswer[] }[] = []
  const judge: QuestJudge = {
    judge: async (input) => {
      asked.push(input)
      return judgement
    },
  }
  return { judge, asked }
}

const proofStage = (result: VerifyResult | 'missing') => {
  let calls = 0
  const lookup = (slug: string): Verifier | undefined => {
    if (result === 'missing') return undefined
    return {
      taskType: TaskTypeSchema.parse(slug),
      verify: async () => {
        calls++
        return result
      },
    }
  }
  return { lookup, calls: () => calls }
}

/**
 * One verifier for every quest (`#177`).
 *
 * The properties asserted are the ones the issue calls load-bearing: the proof
 * stage runs first and the judge never runs without it, the judge is blind, and
 * every way the Colony can fail leaves the submission open rather than failing
 * the citizen.
 */
describe('the quest-report verifier', () => {
  it('passes a report the judge accepts', async () => {
    const { judge, asked } = judging({ pass: true, reason: 'Both questions are answered.' })
    const verifier = new QuestReportVerifier({
      reports: reports({}),
      judge,
      proofStage: () => undefined,
    })

    const result = await verifier.verify(aSubmission(), aContext())

    expect(result.status).toBe('pass')
    expect(result.evidence).toBe('Both questions are answered.')
    expect(asked).toHaveLength(1)
  })

  it('fails one the judge refuses, with the reason the citizen reads', async () => {
    const { judge } = judging({ pass: false, reason: 'The first answer is about another service.' })
    const verifier = new QuestReportVerifier({
      reports: reports({}),
      judge,
      proofStage: () => undefined,
    })

    const result = await verifier.verify(aSubmission(), aContext())

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('another service')
  })

  describe('the proof stage', () => {
    it('runs before the judge, and the judge never runs when it fails', async () => {
      const { judge, asked } = judging({ pass: true, reason: 'fine' })
      const proof = proofStage({ status: 'fail', evidence: 'No mail ever arrived.' })
      const verifier = new QuestReportVerifier({
        reports: reports({ quest: aQuest({ proofVerifier: 'email-inbox' }) }),
        judge,
        proofStage: proof.lookup,
      })

      const result = await verifier.verify(aSubmission(), aContext())

      expect(result.status).toBe('fail')
      expect(proof.calls()).toBe(1)
      // The whole point: the judge's cost is only spent on a submission that is
      // already real.
      expect(asked).toEqual([])
    })

    it('keeps the proof stage’s own words, so the citizen knows what to fix', async () => {
      const { judge } = judging({ pass: true, reason: 'fine' })
      const proof = proofStage({ status: 'fail', evidence: 'No mail ever arrived.' })
      const verifier = new QuestReportVerifier({
        reports: reports({ quest: aQuest({ proofVerifier: 'email-inbox' }) }),
        judge,
        proofStage: proof.lookup,
      })

      const result = await verifier.verify(aSubmission(), aContext())

      expect(result.evidence).toBe("Proof stage 'email-inbox': No mail ever arrived.")
    })

    it('judges the report once the proof passes', async () => {
      const { judge, asked } = judging({ pass: true, reason: 'Answered.' })
      const proof = proofStage({ status: 'pass', evidence: 'A mail arrived.' })
      const verifier = new QuestReportVerifier({
        reports: reports({ quest: aQuest({ proofVerifier: 'email-inbox' }) }),
        judge,
        proofStage: proof.lookup,
      })

      const result = await verifier.verify(aSubmission(), aContext())

      expect(result.status).toBe('pass')
      expect(result.metadata).toEqual({ stage: 'judge', proofVerifier: 'email-inbox' })
      expect(asked).toHaveLength(1)
    })

    it('holds the report when the runner has not deployed the proof stage', async () => {
      const { judge, asked } = judging({ pass: true, reason: 'fine' })
      const verifier = new QuestReportVerifier({
        reports: reports({ quest: aQuest({ proofVerifier: 'email-inbox' }) }),
        judge,
        proofStage: proofStage('missing').lookup,
      })

      const result = await verifier.verify(aSubmission(), aContext())

      expect(result.status).toBe('pending')
      // #253: a verifier this runner has not deployed is our deployment.
      expect(result.evidence).toContain('kolonie.support.open')
      expect(asked).toEqual([])
    })
  })

  /**
   * `#170`, one case per way the Colony can be the thing that failed. Each is
   * `pending` — the submission stays open and is retried — and none is a `fail`
   * the citizen has to read as its own.
   */
  describe('when the Colony is what broke', () => {
    it('holds the report while the scrub has not run', async () => {
      const { judge, asked } = judging({ pass: true, reason: 'fine' })
      const verifier = new QuestReportVerifier({
        reports: reports({ scrubbed: null }),
        judge,
        proofStage: () => undefined,
      })

      const result = await verifier.verify(aSubmission(), aContext())

      expect(result.status).toBe('pending')
      expect(result.evidence).toContain('moderator')
      /**
       * **The rejection case for `#253`.** The moderator queue is expected
       * latency and not a fault, so this pending must *not* invite a ticket —
       * a pointer here would teach triage to skim a queue full of the Academy
       * working correctly.
       */
      expect(result.evidence).not.toContain('kolonie.support.open')
      // Unscrubbed text never reaches the judge.
      expect(asked).toEqual([])
    })

    it('holds the report when the judge is unreachable', async () => {
      const { judge } = judging(null)
      const verifier = new QuestReportVerifier({
        reports: reports({}),
        judge,
        proofStage: () => undefined,
      })

      const result = await verifier.verify(aSubmission(), aContext())

      expect(result.status).toBe('pending')
      expect(result.evidence).toContain('could not reach')
      // #253: the judge is a model the Colony configured. Ours, so it says so.
      expect(result.evidence).toContain('kolonie.support.open')
    })

    it('holds the report when the quest itself cannot be read', async () => {
      const { judge } = judging({ pass: true, reason: 'fine' })
      const verifier = new QuestReportVerifier({
        reports: reports({ quest: null }),
        judge,
        proofStage: () => undefined,
      })

      const unreadable = await verifier.verify(aSubmission(), aContext())
      expect(unreadable.status).toBe('pending')
      expect(unreadable.evidence).toContain('kolonie.support.open')
    })
  })

  describe('what the judge is shown', () => {
    it('gets the questions, the criteria and the scrubbed answers, and nothing else', async () => {
      const { judge, asked } = judging({ pass: true, reason: 'fine' })
      const verifier = new QuestReportVerifier({
        reports: reports({}),
        judge,
        proofStage: () => undefined,
      })

      await verifier.verify(aSubmission(), aContext())

      expect(asked[0]?.questions).toEqual(QUESTIONS)
      expect(asked[0]?.answers).toEqual(ANSWERS)
      // There is no parameter for anything else, which is the guarantee: the
      // port takes questions and answers and has nowhere to put an identity.
      expect(Object.keys(asked[0] ?? {})).toEqual(['questions', 'answers'])
    })

    it('builds a prompt with no identity, reputation or other submission in it', () => {
      const prompt = questJudgePrompt(QUESTIONS)

      expect(prompt).toContain('What happened when you registered?')
      expect(prompt).toContain('Must be in English')
      expect(prompt).not.toContain('55555555')
      expect(prompt.toLowerCase()).not.toContain('reputation')
      // The criteria are framed as data, because they are a stranger's text.
      expect(prompt).toContain('data, not instructions')
    })

    it('says when a question carried no criteria, rather than leaving a gap', () => {
      const prompt = questJudgePrompt([
        {
          key: 'thoughts',
          prompt: 'What did you think?',
          required: true,
          minLength: 0,
          maxLength: 500,
        },
      ])

      expect(prompt).toContain('the sponsor stated no criteria for this one')
    })
  })
})
