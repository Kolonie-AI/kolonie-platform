import { describe, expect, it } from 'vitest'
import { QuestQuestionSchema } from './questions.js'
import { RENT_EXEMPT_MINIMUM_FALLBACK } from '../ledger/transfer.js'
import {
  DEFAULT_PLATFORM_FEE_PERCENT,
  PLATFORM_FEE_PERCENT_VAR,
  QUEST_EDITABLE_STATUSES,
  QUEST_TIER_CAPS_LAMPORTS,
  QUEST_TIER_CAP_SETTINGS,
  QUEST_REVIEW_REWARD_LAMPORTS,
  QUEST_MAX_DURATION_DAYS,
  QUEST_MAX_SLOTS,
  QuestDraftSchema,
  QuestPatchSchema,
  QuestRefusalSchema,
  platformFeePercentFromEnv,
  questCommitment,
  questFeeBreakdown,
  questPayNotice,
  questPayoutSplit,
  questRewardRejection,
  questSubmissionRejection,
  questTier,
  questTierCaps,
  QuestTierSchema,
} from './quest.js'
import { settingNamed } from '../settings/settings.js'
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
    // 10 × 10 for the answers, and 5 each for the first three published
    // obstacles — held on top of the capacity rather than out of it (`#371`).
    expect(
      questCommitment({
        reward: { reputation: 1, lamports: 10 },
        slots: 10,
        publishObstacles: true,
      }),
    ).toBe(115)
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
        questions: [without],
        reward: { lamports: QUEST_TIER_CAPS_LAMPORTS.hard + 1 },
      }),
    ).toContain('hard')
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

  it("pays a steward more than a soft report and far more than a transaction's fee", () => {
    expect(QUEST_REVIEW_REWARD_LAMPORTS).toBeGreaterThan(QUEST_TIER_CAPS_LAMPORTS.soft)
    expect(QUEST_REVIEW_REWARD_LAMPORTS).toBeGreaterThan(5_000 * 100)
    // Small enough that reviewing is not a way to earn — D-105's second
    // condition, which the change of unit had to keep.
    expect(QUEST_REVIEW_REWARD_LAMPORTS).toBeLessThan(QUEST_TIER_CAPS_LAMPORTS['colony-judged'])
  })
})
