import { describe, expect, it } from 'vitest'
import { QuestAnswerFormatSchema, QuestQuestionSchema } from './questions.js'
import { RENT_EXEMPT_MINIMUM_FALLBACK } from '../ledger/transfer.js'
import {
  DEFAULT_PLATFORM_FEE_PERCENT,
  PLATFORM_FEE_PERCENT_VAR,
  QUEST_EDITABLE_STATUSES,
  QUEST_TIER_CAPS_LAMPORTS,
  QUEST_TIER_CAP_SETTINGS,
  QUEST_PROOF_VERIFIERS,
  QUEST_VERIFIER_PROVES,
  QUEST_REFUSAL_LIMIT,
  QUEST_MAX_DURATION_DAYS,
  QUEST_MAX_SLOTS,
  QuestDraftSchema,
  QuestPatchSchema,
  QuestRefusalSchema,
  platformFeePercentFromEnv,
  questCommitment,
  questCommitmentBreakdown,
  questCommitmentLines,
  QUEST_OBSTACLE_BONUS_WINNERS,
  obstacleBonusNotice,
  questFeeBreakdown,
  questPayNotice,
  questPayoutSplit,
  questPriceReach,
  questPriceReachNotice,
  questRewardRejection,
  questSubmissionRejection,
  questTier,
  questTierCaps,
  QuestTierSchema,
} from './quest.js'
import { settingNamed } from '../settings/settings.js'
import { rewardFor } from './task.js'
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
  reward: { reputation: 5, lamports: 0 },
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
  it('allows three refusals before a draft is spent', () => {
    expect(QUEST_REFUSAL_LIMIT).toBe(3)
  })

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
  it('is the price of a report times the number bought, plus what the obstacles cost', () => {
    // 10 × 10 for the answers, and a quarter of one each for the first three
    // published obstacles — held on top of the capacity rather than out of it
    // (`#371`), and a quarter rather than a half since `#632`.
    expect(
      questCommitment({
        reward: { reputation: 1, lamports: 10 },
        slots: 10,
        publishObstacles: true,
      }),
    ).toBe(106)
  })

  /** The share it is given, so the commitment cannot disagree with the payout. */
  it('sizes the obstacle pool from the share it is given (#632)', () => {
    const quest = { reward: { reputation: 1, lamports: 10 }, slots: 10, publishObstacles: true }

    expect(questCommitment(quest, 50)).toBe(115)
    expect(questCommitment(quest, 0)).toBe(100)
  })

  it('holds nothing for obstacles a sponsor chose not to publish', () => {
    expect(
      questCommitment({
        reward: { reputation: 1, lamports: 10 },
        slots: 10,
        publishObstacles: false,
      }),
    ).toBe(100)
  })

  it('is nothing for a quest that pays reputation only', () => {
    expect(
      questCommitment({
        reward: { reputation: 5, lamports: 0 },
        slots: 1000,
        publishObstacles: true,
      }),
    ).toBe(0)
  })

  /**
   * A quest paying one credit an answer has nothing to halve, and inventing a
   * credit for it would be the Colony paying for a stranger's product research.
   */
  it('pays no obstacle bonus on a quest whose answers pay one credit', () => {
    expect(
      questCommitment({
        reward: { reputation: 0, lamports: 1 },
        slots: 10,
        publishObstacles: true,
      }),
    ).toBe(10)
  })
})

describe('what the commitment is made of (#628)', () => {
  const quest = { reward: { lamports: 10_000_000 }, slots: 3, publishObstacles: true }

  /** The definition of done: the itemised lines sum to the committed total. */
  it('itemises a total that its own parts add up to', () => {
    const breakdown = questCommitmentBreakdown(quest, { feePercent: 25 })

    expect(breakdown.answers.total + (breakdown.obstacles?.total ?? 0)).toBe(breakdown.total)
    expect(breakdown.total).toBe(questCommitment(quest))
  })

  it('names the answers and the pool separately, which the total never did', () => {
    const breakdown = questCommitmentBreakdown(quest, { feePercent: 25 })

    expect(breakdown.answers).toEqual({ slots: 3, each: 10_000_000, total: 30_000_000 })
    expect(breakdown.obstacles).toEqual({
      winners: QUEST_OBSTACLE_BONUS_WINNERS,
      each: 2_500_000,
      total: 7_500_000,
    })
  })

  /**
   * `null` and not a zero: a sponsor that turned obstacles off made a choice,
   * and a quest priced too low to take a share of has nothing to hold. Neither
   * should read as *0 lamports of obstacle pool*.
   */
  it('holds no pool where the sponsor turned obstacles off, and says so', () => {
    const breakdown = questCommitmentBreakdown(
      { ...quest, publishObstacles: false },
      { feePercent: 25 },
    )

    expect(breakdown.obstacles).toBeNull()
    expect(breakdown.total).toBe(30_000_000)
    expect(questCommitmentLines(breakdown, { publishObstacles: false }).join(' ')).toContain(
      'publishObstacles to false',
    )
  })

  it('holds no pool on a quest priced too low to take a share of', () => {
    expect(
      questCommitmentBreakdown(
        { reward: { lamports: 1 }, slots: 3, publishObstacles: true },
        {
          feePercent: 25,
        },
      ).obstacles,
    ).toBeNull()
  })

  it('states what the sponsor commits and what the citizen receives, without arithmetic', () => {
    const said = questCommitmentLines(questCommitmentBreakdown(quest, { feePercent: 25 })).join(
      '\n',
    )

    expect(said).toContain('37500000 lamports held')
    expect(said).toContain('3 answer(s) at 10000000')
    expect(said).toContain('the citizen receives 7500000')
    expect(said).toContain('the Colony 2500000')
    expect(said).toContain(
      'Nothing here is refundable: publishing is the purchase, anything above the amount is ' +
        'kept and does not extend the quest, and capacity nobody fills is not returned at expiry.',
    )
  })

  it('does not offer unused obstacle bonuses back to the sponsor', () => {
    expect(obstacleBonusNotice(quest)).toContain(
      'Nothing here is refundable, including bonuses nobody earns.',
    )
  })

  it('says nothing about money for a quest that pays reputation only', () => {
    const said = questCommitmentLines(
      questCommitmentBreakdown(
        { reward: { lamports: 0 }, slots: 3, publishObstacles: true },
        {
          feePercent: 25,
        },
      ),
    )

    expect(said).toEqual([
      'This quest pays reputation and nothing else, so nothing is held and there is no invoice.',
    ])
  })

  /** The share is a setting (`#632`), and the itemisation has to follow it. */
  it('itemises at the obstacle share it is given', () => {
    const breakdown = questCommitmentBreakdown(quest, { feePercent: 25, obstaclePercent: 50 })

    expect(breakdown.obstacles?.each).toBe(5_000_000)
    expect(breakdown.answers.total + (breakdown.obstacles?.total ?? 0)).toBe(breakdown.total)
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

  /** `#626`: proven means the question asks for what the verifier establishes. */
  const provenEmail = QuestQuestionSchema.parse({
    key: 'address',
    prompt: 'Which address did you register?',
    format: 'email',
    provenBy: true,
  })

  it('is hard when every required question is one the verifier establishes', () => {
    expect(questTier({ proofVerifier: 'email-inbox', questions: [provenEmail] })).toBe('hard')
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
      reward: { lamports: QUEST_TIER_CAPS_LAMPORTS.soft + 1 },
    })

    expect(rejection).toContain('soft')
    expect(rejection).toContain(String(QUEST_TIER_CAPS_LAMPORTS.soft))
  })

  it('lets the same price through once the quest can be checked', () => {
    const reward = { lamports: QUEST_TIER_CAPS_LAMPORTS.soft + 1 }

    expect(
      questRewardRejection({ proofVerifier: null, questions: [withCriteria], reward }),
    ).toBeUndefined()
  })

  it('caps a hard quest too, because a typo should not empty a balance', () => {
    expect(
      questRewardRejection({
        proofVerifier: 'email-inbox',
        questions: [provenEmail],
        reward: { lamports: QUEST_TIER_CAPS_LAMPORTS.hard + 1 },
      }),
    ).toContain('hard')
  })

  /**
   * `#626`. The tier used to be *a verifier is named*, so naming one raised the
   * ceiling two hundredfold whether or not it bore on what the quest asked.
   */
  describe('a verifier has to prove what the quest asks', () => {
    /** The case that found it: star and fork, proved by `github-account`. */
    const starAndFork = {
      proofVerifier: 'github-account',
      questions: [
        QuestQuestionSchema.parse({
          key: 'starred',
          prompt: 'Which of our repositories did you star?',
        }),
      ],
    }

    it('is not hard when the verifier bears on no question the quest asks', () => {
      expect(questTier(starAndFork)).toBe('soft')
    })

    it('is colony-judged rather than soft when the questions state criteria', () => {
      expect(
        questTier({
          ...starAndFork,
          questions: [
            QuestQuestionSchema.parse({
              ...starAndFork.questions[0],
              criteria: 'Name the repository.',
            }),
          ],
        }),
      ).toBe('colony-judged')
    })

    it('refuses the claim when the format is not the shape the verifier proves', () => {
      const marked = QuestQuestionSchema.parse({
        key: 'starred',
        prompt: 'Which repository did you star?',
        provenBy: true,
      })

      expect(questTier({ proofVerifier: 'github-account', questions: [marked] })).toBe('soft')
      expect(
        questTier({
          proofVerifier: 'github-account',
          questions: [QuestQuestionSchema.parse({ ...marked, format: 'email' })],
        }),
      ).toBe('soft')
    })

    it('needs every required question proven, not merely one of them', () => {
      const deed = QuestQuestionSchema.parse({ key: 'starred', prompt: 'Did you star it?' })
      const optionalDeed = QuestQuestionSchema.parse({ ...deed, required: false })

      expect(questTier({ proofVerifier: 'email-inbox', questions: [provenEmail, deed] })).toBe(
        'soft',
      )
      // An optional question is not part of what the sponsor is buying, so it
      // does not hold the tier down.
      expect(
        questTier({ proofVerifier: 'email-inbox', questions: [provenEmail, optionalDeed] }),
      ).toBe('hard')
    })

    it('is not hard when the quest already requires what the verifier proves', () => {
      expect(
        questTier({
          proofVerifier: 'email-inbox',
          questions: [provenEmail],
          requires: ['mailbox'],
        }),
      ).toBe('soft')
    })

    it('still lets a verifier be a gate, at whatever tier the questions earn', () => {
      const judged = QuestQuestionSchema.parse({
        key: 'what-happened',
        prompt: 'What happened?',
        criteria: 'Say what the page did.',
      })

      expect(questTier({ proofVerifier: 'github-account', questions: [judged] })).toBe(
        'colony-judged',
      )
    })

    it('names the unproven question in the refusal rather than only the price', () => {
      const rejection = questRewardRejection({
        ...starAndFork,
        reward: { lamports: QUEST_TIER_CAPS_LAMPORTS.hard },
      })

      expect(rejection).toContain('not hard because')
      expect(rejection).toContain('github-account')
      expect(rejection).toContain('a GitHub account')
    })

    it('names a subject and a format for every verifier the Colony runs', () => {
      for (const verifier of QUEST_PROOF_VERIFIERS) {
        const proves = QUEST_VERIFIER_PROVES[verifier]
        expect(proves.subject.length).toBeGreaterThan(0)
        expect(QuestAnswerFormatSchema.options).toContain(proves.format)
      }
    })
  })

  describe('the ceilings a setting may turn (#630)', () => {
    const nothingHeld = (): undefined => undefined

    it('is the constants when nothing is set', () => {
      expect(questTierCaps(nothingHeld)).toEqual(QUEST_TIER_CAPS_LAMPORTS)
    })

    it('takes the value a maintainer wrote', () => {
      const caps = questTierCaps((name) =>
        name === QUEST_TIER_CAP_SETTINGS.soft ? '250000' : undefined,
      )

      expect(caps.soft).toBe(250_000)
    })

    it('defaults each tier on its own, so lowering one keeps the other two', () => {
      const caps = questTierCaps((name) =>
        name === QUEST_TIER_CAP_SETTINGS.soft ? '1' : undefined,
      )

      expect(caps.soft).toBe(1)
      expect(caps.hard).toBe(QUEST_TIER_CAPS_LAMPORTS.hard)
      expect(caps['colony-judged']).toBe(QUEST_TIER_CAPS_LAMPORTS['colony-judged'])
    })

    /**
     * The rejection case the definition of done asks for, in the direction that
     * matters: a value that cannot be read must never be read as *no ceiling*.
     * Zero and a negative arrive from the environment, which nothing validates.
     */
    it.each([['not a number'], [''], ['0'], ['-1'], ['1.5e9']])(
      'falls back to the constant rather than to no ceiling on %j',
      (held) => {
        const caps = questTierCaps((name) =>
          name === QUEST_TIER_CAP_SETTINGS.soft ? held : undefined,
        )

        expect(caps.soft).toBe(QUEST_TIER_CAPS_LAMPORTS.soft)
      },
    )

    it('is what questRewardRejection judges against when it is passed one', () => {
      const quest = {
        proofVerifier: null,
        questions: [without],
        reward: { lamports: QUEST_TIER_CAPS_LAMPORTS.soft },
      }

      // At the constant it passes; under a lowered ceiling the same quest does not.
      expect(questRewardRejection(quest)).toBeUndefined()
      expect(questRewardRejection(quest, { ...QUEST_TIER_CAPS_LAMPORTS, soft: 1 })).toContain(
        'soft',
      )
    })

    it('names a setting for every tier, so none can be left unturnable', () => {
      for (const tier of QuestTierSchema.options) {
        expect(QUEST_TIER_CAP_SETTINGS[tier]).toMatch(/^QUEST_TIER_CAP_/)
        expect(settingNamed(QUEST_TIER_CAP_SETTINGS[tier])).toBeDefined()
      }
    })
  })
})

describe('the platform fee', () => {
  describe('the rate in force', () => {
    it('is 25 per cent when nothing configures it', () => {
      expect(platformFeePercentFromEnv({})).toBe(DEFAULT_PLATFORM_FEE_PERCENT)
      expect(DEFAULT_PLATFORM_FEE_PERCENT).toBe(25)
    })

    it('takes a configured whole percentage', () => {
      expect(platformFeePercentFromEnv({ [PLATFORM_FEE_PERCENT_VAR]: '10' })).toBe(10)
    })

    /**
     * An empty variable is a variable somebody set and left blank, which is the
     * shape a deploy template produces. It means *unset*, not zero — a rate of
     * zero has to be typed.
     */
    it('reads an empty variable as unset rather than as a rate of zero', () => {
      expect(platformFeePercentFromEnv({ [PLATFORM_FEE_PERCENT_VAR]: '   ' })).toBe(
        DEFAULT_PLATFORM_FEE_PERCENT,
      )
    })

    it('takes zero when zero is what was written', () => {
      expect(platformFeePercentFromEnv({ [PLATFORM_FEE_PERCENT_VAR]: '0' })).toBe(0)
    })

    /**
     * The rejection cases. A fractional rate is the interesting one: it looks
     * reasonable and cannot be applied to an integer ledger without inventing a
     * rounding rule per quest.
     */
    it.each(['25.5', '-1', '101', 'a quarter', ''.padEnd(3, '9')])(
      'refuses %s rather than guessing what was meant',
      (value) => {
        if (value === '999') {
          expect(() => platformFeePercentFromEnv({ [PLATFORM_FEE_PERCENT_VAR]: value })).toThrow(
            /0 to 100/,
          )
          return
        }
        expect(() => platformFeePercentFromEnv({ [PLATFORM_FEE_PERCENT_VAR]: value })).toThrow()
      },
    )
  })

  describe('splitting one accepted report', () => {
    it('gives the Colony a quarter of a thousand', () => {
      expect(questPayoutSplit(1000, 25)).toEqual({ toCitizen: 750, toTreasury: 250 })
    })

    it('always sums back to what was funded', () => {
      for (const lamports of [1, 2, 3, 7, 99, 100, 101, 1000, 12345]) {
        const { toCitizen, toTreasury } = questPayoutSplit(lamports, 25)
        expect(toCitizen + toTreasury).toBe(lamports)
      }
    })

    /**
     * **The remainder goes to the citizen**, and this is the assertion that
     * fixes which side it lands on. `floor` on the fee means a rounding can
     * never pay a citizen less than the quest advertised.
     */
    it('rounds in the citizen’s favour, never the Colony’s', () => {
      expect(questPayoutSplit(3, 25)).toEqual({ toCitizen: 3, toTreasury: 0 })
      expect(questPayoutSplit(7, 25)).toEqual({ toCitizen: 6, toTreasury: 1 })
      expect(questPayoutSplit(99, 25)).toEqual({ toCitizen: 75, toTreasury: 24 })
    })

    /**
     * The pilot, and the case `kolonie-docs#130` created deliberately: at one
     * cent a report the fee is nothing and the citizen keeps the whole cent.
     */
    it('takes nothing from a one-cent pilot report', () => {
      expect(questPayoutSplit(1, 25)).toEqual({ toCitizen: 1, toTreasury: 0 })
    })

    it('takes nothing at a rate of zero, whatever the reward', () => {
      expect(questPayoutSplit(1000, 0)).toEqual({ toCitizen: 1000, toTreasury: 0 })
    })

    it('pays a citizen nothing for a quest that pays nothing', () => {
      expect(questPayoutSplit(0, 25)).toEqual({ toCitizen: 0, toTreasury: 0 })
    })
  })
})

/**
 * What the two surfaces show, and that they show the payout's own arithmetic
 * (`#463`).
 */
describe('what a sponsor and a citizen are told about the fee', () => {
  describe('the sponsor’s breakdown', () => {
    it('multiplies capacity through, because a percentage is not the number that decides', () => {
      expect(questFeeBreakdown({ lamports: 1000, slots: 40, feePercent: 25 })).toMatchObject({
        funded: 40_000,
        toCitizens: 30_000,
        toColony: 10_000,
        perReport: { toCitizen: 750, toTreasury: 250 },
      })
    })

    /**
     * **The rejection case.** Every figure shown has to equal what the payout
     * books, per report and in total. A breakdown that computed its own share
     * would drift the first time either side was edited, and it would drift
     * invisibly.
     */
    it('equals what the payout computation returns, per report and multiplied through', () => {
      for (const lamports of [1, 2, 7, 99, 100, 1000, 12345]) {
        for (const feePercent of [0, 10, 25, 100]) {
          for (const slots of [1, 3, 40]) {
            const shown = questFeeBreakdown({ lamports, slots, feePercent })
            const paid = questPayoutSplit(lamports, feePercent)

            expect(shown.perReport).toEqual(paid)
            expect(shown.toCitizens).toBe(paid.toCitizen * slots)
            expect(shown.toColony).toBe(paid.toTreasury * slots)
            expect(shown.toCitizens + shown.toColony).toBe(shown.funded)
          }
        }
      }
    })

    it('says the fee rounds away rather than printing a zero', () => {
      expect(questFeeBreakdown({ lamports: 1, slots: 1000, feePercent: 25 }).free).toBe(true)
      expect(questFeeBreakdown({ lamports: 1000, slots: 1, feePercent: 25 }).free).toBe(false)
    })
  })

  describe('what a citizen reads', () => {
    /** Net first: the figure a citizen reads is what reaches its balance. */
    it('leads with what reaches the citizen’s balance', () => {
      const notice = questPayNotice({ lamports: 1000, reputation: 2, feePercent: 25 })

      expect(notice).toMatch(/^Pays you 750 credit\(s\) and 2 reputation/)
    })

    /** The gross and the share are stated too, so nothing is concealed. */
    it('states the gross and the Colony’s share behind it', () => {
      const notice = questPayNotice({ lamports: 1000, reputation: 2, feePercent: 25 })

      expect(notice).toContain('funds 1000')
      expect(notice).toContain('250')
    })

    /** Named, not shown only as a percentage. */
    it('names the fee in plain words with the rate beside it', () => {
      const notice = questPayNotice({ lamports: 1000, reputation: 2, feePercent: 25 })

      expect(notice).toContain('platform fee')
      expect(notice).toContain("Colony's share")
      expect(notice).toContain('25%')
    })

    /** A quest published under an earlier rate says that rate, not today's. */
    it('shows the rate it was published under', () => {
      const notice = questPayNotice({ lamports: 1000, reputation: 2, feePercent: 10 })

      expect(notice).toContain('10%')
      expect(notice).toContain('Pays you 900')
      expect(notice).not.toContain('25%')
    })

    /**
     * Where the fee rounds away, the citizen is told it receives the full
     * amount rather than being shown a zero that reads as a charge.
     */
    it('says the citizen receives the full amount when the fee rounds away', () => {
      const notice = questPayNotice({ lamports: 1, reputation: 1, feePercent: 25 })

      expect(notice).toContain('Pays you 1 credit(s)')
      expect(notice).toContain('the Colony takes nothing')
      expect(notice).not.toContain('0 ')
      expect(notice).not.toContain('platform fee')
    })
  })
})

/**
 * D-110 (`kolonie-docs#225`). The two prices that were still in cents when D-106
 * moved settlement to SOL, re-taken in lamports.
 *
 * **What is asserted is the ratio and the ordering, not the figures.** A test
 * that restated `100_000_000` would only prove the constant had been typed
 * twice. The ratio is what `governance/quests.md` actually argues — *"a softly
 * verified Quest must never pay more than the reputation it risks"* is a claim
 * about proportion — and it is what a later re-take at a new price has to
 * preserve.
 */
describe('the prices D-106 left without a unit', () => {
  it('keeps the tier ceilings at 200 : 20 : 1, whatever the price of SOL', () => {
    const { hard, soft } = QUEST_TIER_CAPS_LAMPORTS
    const judged = QUEST_TIER_CAPS_LAMPORTS['colony-judged']

    expect(hard / soft).toBe(200)
    expect(judged / soft).toBe(20)
    // The same ratio the credit ceilings carried, so this is a change of unit
    // rather than a repricing that arrived wearing one.
    expect(hard / soft).toBe(QUEST_TIER_CAPS_LAMPORTS.hard / QUEST_TIER_CAPS_LAMPORTS.soft)
    expect(judged / soft).toBe(
      QUEST_TIER_CAPS_LAMPORTS['colony-judged'] / QUEST_TIER_CAPS_LAMPORTS.soft,
    )
  })

  it('prices every tier above the fee that carries a payout', () => {
    // A ceiling below the cost of paying it out would be a tier that cannot be
    // used. 5_000 lamports is the Solana base fee.
    for (const cap of Object.values(QUEST_TIER_CAPS_LAMPORTS)) {
      expect(cap).toBeGreaterThan(5_000 * 10)
    }
  })

  /**
   * Not an oversight and not a bug: a first payout at the soft ceiling accrues
   * until it clears the chain minimum, which `#505` does for every payout. The
   * assertion is here so that somebody raising the ceiling has to meet this
   * comment rather than discover it from a citizen who was not paid.
   */
  it('leaves the soft ceiling below the rent-exempt minimum, knowingly', () => {
    expect(QUEST_TIER_CAPS_LAMPORTS.soft).toBeLessThan(RENT_EXEMPT_MINIMUM_FALLBACK)
    expect(QUEST_TIER_CAPS_LAMPORTS['colony-judged']).toBeGreaterThan(RENT_EXEMPT_MINIMUM_FALLBACK)
  })

  /**
   * **The three review-reward tests stood here and are gone** (`#724`).
   *
   * They asserted that a decision paid far more than a transaction fee, less
   * than a colony-judged report, and that the dial overrode the constant. The
   * Colony decides its own quests now (`#693`), so the payout has nobody to pay
   * and the constant, the setting and `questReviewReward` were removed with it.
   *
   * **The inversion they recorded is what is worth keeping.** `#651` measured a
   * decision paying a fifth of what answering paid, and the tests were left
   * asserting it *on purpose*, so that whoever read this file met the question
   * rather than inheriting the answer. The question is now settled by removal
   * rather than by re-pricing, and D-105 is not reversed by it: its argument was
   * about a role that decides, and no role decides.
   */
})

describe('how far a price reaches (#718)', () => {
  /**
   * The Colony's first paid quest, `e60fdcce`, at the figure it published:
   * 1,000,000 with a 25% fee. Three answers, one wallet reached.
   */
  it('measures what an accepted answer is owed, not the headline', () => {
    expect(questPayoutSplit(1_000_000, 25).toCitizen).toBe(750_000)
    expect(questPriceReach({ lamports: 1_000_000, feePercent: 25 }).perAnswer).toBe(750_000)
    expect(questPriceReach({ lamports: 1_000_000, feePercent: 25 }).clears).toBe(false)
  })

  /**
   * The order the ledger books in — `rewardFor` first, then the fee. On a quest
   * `rewardFor` now changes nothing (D-113), so the two agree exactly rather
   * than to within a lamport of rounding. The test exists so a change to either
   * function has to come past the agreement.
   */
  it('agrees with what bookVerdict pays, whatever was declared', () => {
    for (const assistance of [
      'none',
      'unknown',
      'operator-provided',
      'operator-performed',
    ] as const)
      expect(questPriceReach({ lamports: 1_000_000, feePercent: 25 }).perAnswer).toBe(
        questPayoutSplit(
          rewardFor({ lamports: 1_000_000, reputation: 0 }, assistance, 'quest').lamports,
          25,
        ).toCitizen,
      )
  })

  /**
   * **The 1,200,000 case, which is what `#718` was filed about.** The console
   * compared the post-fee figure — 900,000 against a floor of 890,880 — and told
   * the sponsor nothing, while an assisted answer was paid 450,000.
   *
   * D-113 removed the second deduction, so this price now reaches: the figure
   * that used to be the optimistic half is the only figure there is. Kept as the
   * case it is, because a reader arriving from `#718` needs to see what happened
   * to it rather than find it deleted.
   */
  it('clears at the price that used to reach only unassisted answers', () => {
    const reach = questPriceReach({ lamports: 1_200_000, feePercent: 25 })

    expect(reach.perAnswer).toBe(900_000)
    expect(reach.perAnswer).toBeGreaterThan(RENT_EXEMPT_MINIMUM_FALLBACK)
    expect(reach.clears).toBe(true)
    expect(questPriceReachNotice(reach)).toBeNull()
  })

  it('does not clear when the post-fee figure is below the chain minimum', () => {
    const reach = questPriceReach({ lamports: 1_000_000, feePercent: 25 })

    expect(reach.perAnswer).toBe(750_000)
    expect(reach.chainMinimum).toBe(RENT_EXEMPT_MINIMUM_FALLBACK)
    expect(reach.clears).toBe(false)

    const notice = questPriceReachNotice(reach)
    expect(notice).toContain('no answer reaches')
    // It says what accrual is, because a sentence that only said *cannot
    // receive* would read as a refusal to pay.
    expect(notice).toContain('still owed')
  })

  /**
   * The tier the issue asked a decision about. `soft` accrues by design — see
   * QUEST_TIER_CAPS_LAMPORTS for why the cap does not rise instead — and this
   * asserts the state that decision describes, so raising the cap without
   * revisiting it fails here.
   */
  it('records that the whole soft tier accrues, at its ceiling and below', () => {
    expect(
      questPriceReach({ lamports: QUEST_TIER_CAPS_LAMPORTS.soft, feePercent: 25 }).clears,
    ).toBe(false)
    expect(questPriceReach({ lamports: QUEST_TIER_CAPS_LAMPORTS.soft, feePercent: 0 }).clears).toBe(
      false,
    )
  })

  it('carries the reach on the commitment, where the sponsor decides', () => {
    const priced = { reward: { lamports: 1_000_000 }, slots: 3, publishObstacles: false }

    expect(questCommitmentBreakdown(priced, { feePercent: 25 }).reach?.clears).toBe(false)
    expect(
      questCommitmentLines(questCommitmentBreakdown(priced, { feePercent: 25 })).join(' '),
    ).toContain('no answer reaches a first-time')
  })

  /** A quest that pays only reputation has no price to measure. */
  it('says nothing about a quest that pays no money', () => {
    expect(
      questCommitmentBreakdown(
        { reward: { lamports: 0 }, slots: 3, publishObstacles: false },
        { feePercent: 25 },
      ).reach,
    ).toBeNull()
  })
})
