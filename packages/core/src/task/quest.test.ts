import { describe, expect, it } from 'vitest'
import {
  QUEST_EDITABLE_STATUSES,
  QUEST_MAX_DURATION_DAYS,
  QUEST_MAX_SLOTS,
  QuestDraftSchema,
  QuestPatchSchema,
  QuestRefusalSchema,
  questCommitment,
  questSubmissionRejection,
} from './quest.js'
import { TaskStatusSchema, acceptsEdits } from './task.js'

const NOW = new Date('2026-08-03T12:00:00.000Z')

const aDraft = (overrides: Record<string, unknown> = {}) => ({
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
