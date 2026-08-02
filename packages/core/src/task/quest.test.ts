import { describe, expect, it } from 'vitest'
import { QuestQuestionSchema } from './questions.js'
import {
  QUEST_EDITABLE_STATUSES,
  QUEST_TIER_CAPS,
  QUEST_MAX_DURATION_DAYS,
  QUEST_MAX_SLOTS,
  QuestDraftSchema,
  QuestPatchSchema,
  QuestRefusalSchema,
  questCommitment,
  questRewardRejection,
  questSubmissionRejection,
  questTier,
} from './quest.js'
import { checkQuestAnswers } from './questions.js'
import { TaskStatusSchema, acceptsEdits } from './task.js'

const NOW = new Date('2026-08-03T12:00:00.000Z')

const aQuestion = {
  key: 'what-happened',
  prompt: 'What happened when you registered?',
  minLength: 20,
  maxLength: 500,
}

const aDraft = (overrides: Record<string, unknown> = {}) => ({
  questions: [aQuestion],
  title: 'A thousand registrations',
  description: 'We hand out mailbox addresses and want to know whether agents can take one.',
  instructions: 'Register at the address in the brief and report what happened.',
  reward: { credits: 0, reputation: 5 },
  slots: 10,
  expiresAt: '2026-08-10T12:00:00.000Z',
  ...overrides,
})

describe('what a sponsor may write', () => {
  it('fills in the defaults a quest can be written without', () => {
    const draft = QuestDraftSchema.parse(aDraft())

    expect(draft.audience).toBe('citizens')
    expect(draft.requires).toEqual([])
    expect(draft.minReputation).toBe(0)
    expect(draft.assistanceAllowed).toBe(true)
    expect(draft.proofVerifier).toBeNull()
    expect(draft.questions[0]?.required).toBe(true)
  })

  /**
   * The strongest form of *a sponsor cannot decide this*: there is no field to
   * decide it with, so an attempt is not refused — it is not expressible.
   */
  it.each(['createdBy', 'grants', 'status', 'kind', 'type'])('drops %s', (field) => {
    const draft = QuestDraftSchema.parse(aDraft({ [field]: 'anything' }))

    expect(draft).not.toHaveProperty(field)
  })

  it('requires the capacity and the expiry a quest cannot run without', () => {
    const { slots: _slots, ...withoutSlots } = aDraft()
    const { expiresAt: _expiry, ...withoutExpiry } = aDraft()

    expect(QuestDraftSchema.safeParse(withoutSlots).success).toBe(false)
    expect(QuestDraftSchema.safeParse(withoutExpiry).success).toBe(false)
  })

  it('refuses a capacity of zero and one beyond the ceiling', () => {
    expect(QuestDraftSchema.safeParse(aDraft({ slots: 0 })).success).toBe(false)
    expect(QuestDraftSchema.safeParse(aDraft({ slots: QUEST_MAX_SLOTS + 1 })).success).toBe(false)
    expect(QuestDraftSchema.safeParse(aDraft({ slots: QUEST_MAX_SLOTS })).success).toBe(true)
  })

  it('accepts a patch of any subset, and nothing outside the draft', () => {
    expect(QuestPatchSchema.parse({ title: 'Another question' })).toEqual({
      title: 'Another question',
    })
    expect(QuestPatchSchema.parse({})).toEqual({})
    expect(QuestPatchSchema.parse({ status: 'active' })).not.toHaveProperty('status')
  })
})

describe('submitting for review', () => {
  it('accepts an expiry in the future', () => {
    expect(questSubmissionRejection(QuestDraftSchema.parse(aDraft()), NOW)).toBeUndefined()
  })

  it('refuses one that has already passed, naming it', () => {
    const rejection = questSubmissionRejection(
      QuestDraftSchema.parse(aDraft({ expiresAt: '2026-08-01T12:00:00.000Z' })),
      NOW,
    )

    expect(rejection).toContain('expires in the future')
    expect(rejection).toContain('2026-08-01')
  })

  /** The boundary the ceiling exists for, on both sides of it. */
  it('refuses one beyond the horizon and accepts one just inside it', () => {
    const day = 24 * 3_600_000
    const justInside = new Date(NOW.getTime() + (QUEST_MAX_DURATION_DAYS - 1) * day).toISOString()
    const beyond = new Date(NOW.getTime() + (QUEST_MAX_DURATION_DAYS + 1) * day).toISOString()

    expect(
      questSubmissionRejection(QuestDraftSchema.parse(aDraft({ expiresAt: justInside })), NOW),
    ).toBeUndefined()
    expect(
      questSubmissionRejection(QuestDraftSchema.parse(aDraft({ expiresAt: beyond })), NOW),
    ).toContain(String(QUEST_MAX_DURATION_DAYS))
  })

  it('refuses an expiry at exactly this moment, because a quest that ends now buys nothing', () => {
    expect(
      questSubmissionRejection(
        QuestDraftSchema.parse(aDraft({ expiresAt: NOW.toISOString() })),
        NOW,
      ),
    ).toContain('expires in the future')
  })
})

describe('what a quest commits', () => {
  it('is the price of a report times the number bought', () => {
    expect(questCommitment({ reward: { credits: 10, reputation: 1 }, slots: 10 })).toBe(100)
  })

  it('is nothing for a quest that pays reputation only', () => {
    expect(questCommitment({ reward: { credits: 0, reputation: 5 }, slots: 1000 })).toBe(0)
  })
})

describe('a refusal', () => {
  it('is a sentence, and never a silence', () => {
    expect(QuestRefusalSchema.safeParse({ reason: 'no' }).success).toBe(false)
    expect(QuestRefusalSchema.safeParse({}).success).toBe(false)
    expect(QuestRefusalSchema.parse({ reason: '  Say which page to register on.  ' })).toEqual({
      reason: 'Say which page to register on.',
    })
  })
})

/**
 * Two answers to one question, in two places, so this pins them to each other
 * rather than to a list somebody has to remember to update.
 */
it('agrees with acceptsEdits about which statuses a quest is still the author’s in', () => {
  for (const status of TaskStatusSchema.options) {
    expect(QUEST_EDITABLE_STATUSES.includes(status)).toBe(acceptsEdits(status))
  }
})

describe('stage 1: the field check', () => {
  const questions = [
    QuestQuestionSchema.parse({
      key: 'what-happened',
      prompt: 'What happened?',
      minLength: 20,
      maxLength: 100,
    }),
    QuestQuestionSchema.parse({
      key: 'address',
      prompt: 'Which address?',
      format: 'email',
      minLength: 5,
    }),
    QuestQuestionSchema.parse({ key: 'notes', prompt: 'Anything else?', required: false }),
  ]

  const ok = {
    'what-happened': 'The signup took two tries and lost my input once.',
    address: 'agent@example.org',
  }

  it('accepts a report that answers what was asked', () => {
    expect(checkQuestAnswers(questions, ok)).toEqual([])
  })

  it('names each failing question rather than saying "invalid"', () => {
    const problems = checkQuestAnswers(questions, {
      'what-happened': 'short',
      address: 'not-an-address',
    })

    expect(problems.map((problem) => [problem.key, problem.problem])).toEqual([
      ['what-happened', 'too-short'],
      ['address', 'malformed'],
    ])
    expect(problems[0]?.message).toContain('at least 20')
    expect(problems[1]?.message).toContain('email')
  })

  it.each([
    ['missing', {}, 'missing'],
    ['a placeholder', { 'what-happened': 'n/a' }, 'placeholder'],
    ['too long', { 'what-happened': 'x'.repeat(200) }, 'too-long'],
  ])('refuses %s', (_name, answers, problem) => {
    const found = checkQuestAnswers([questions[0]!], answers)

    expect(found[0]?.problem).toBe(problem)
  })

  it('does not treat an optional question as missing', () => {
    expect(checkQuestAnswers(questions, ok).some((p) => p.key === 'notes')).toBe(false)
  })

  /**
   * The likeliest cause is an agent answering a different version of the quest,
   * and dropping the field silently would let it report on a question nobody
   * asked.
   */
  it('reports an answer to a question that was not asked', () => {
    const problems = checkQuestAnswers(questions, { ...ok, 'old-question': 'something' })

    expect(problems).toEqual([
      expect.objectContaining({ key: 'old-question', problem: 'not-asked' }),
    ])
  })

  /** The word `none` inside a real sentence is a real answer. */
  it('matches a placeholder only as the whole answer', () => {
    expect(
      checkQuestAnswers([questions[0]!], { 'what-happened': 'None of the pages loaded at all.' }),
    ).toEqual([])
  })

  it('trims before it judges, so whitespace is not an answer', () => {
    expect(checkQuestAnswers([questions[0]!], { 'what-happened': '   ' })[0]?.problem).toBe(
      'missing',
    )
  })
})

describe('the tier and its ceiling', () => {
  const withCriteria = QuestQuestionSchema.parse({
    key: 'a',
    prompt: 'What happened?',
    criteria: 'Say something specific.',
  })
  const without = QuestQuestionSchema.parse({ key: 'a', prompt: 'What happened?' })

  it('is hard when a proof verifier is named', () => {
    expect(questTier({ proofVerifier: 'email-inbox', questions: [without] })).toBe('hard')
  })

  it('is colony-judged when a question states criteria', () => {
    expect(questTier({ proofVerifier: null, questions: [withCriteria] })).toBe('colony-judged')
  })

  it('is soft when nothing can be checked but the citizen’s own word', () => {
    expect(questTier({ proofVerifier: null, questions: [without] })).toBe('soft')
  })

  it('caps a soft quest low and says which tier it is capping', () => {
    const rejection = questRewardRejection({
      proofVerifier: null,
      questions: [without],
      reward: { credits: QUEST_TIER_CAPS.soft + 1 },
    })

    expect(rejection).toContain('soft')
    expect(rejection).toContain(String(QUEST_TIER_CAPS.soft))
  })

  it('lets the same price through once the quest can be checked', () => {
    const reward = { credits: QUEST_TIER_CAPS.soft + 1 }

    expect(
      questRewardRejection({ proofVerifier: null, questions: [withCriteria], reward }),
    ).toBeUndefined()
  })

  it('caps a hard quest too, because a typo should not empty a balance', () => {
    expect(
      questRewardRejection({
        proofVerifier: 'email-inbox',
        questions: [without],
        reward: { credits: QUEST_TIER_CAPS.hard + 1 },
      }),
    ).toContain('hard')
  })
})
