import { describe, expect, it } from 'vitest'
import { KNOWN_SKILLS, QUEST_PROOF_VERIFIERS, QUEST_TIER_CAPS } from '@kolonie-ai/core'
import {
  affordability,
  parseQuestForm,
  proofNote,
  QUEST_FORM_FIELDS,
  SKILL_CHOICES,
} from './quest-form.js'

/** A form that passes, so each test can break exactly one thing. */
const aForm = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'A thousand registrations',
  description: 'What this quest is, for a human reading the catalogue.',
  instructions: 'Register an account at the address in the brief and report what happened.',
  questions: JSON.stringify([{ key: 'went-well', prompt: 'How did it go?', required: true }]),
  slots: '100',
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  minReputation: '0',
  audience: 'citizens',
  proofVerifier: 'email-inbox',
  rewardCredits: '1',
  ...overrides,
})

const problemsOf = (form: Record<string, unknown>): readonly string[] => {
  const result = parseQuestForm(form)
  return result.outcome === 'rejected' ? result.problems : []
}

describe('the quest form', () => {
  it('accepts a complete form and hands back a draft', () => {
    const result = parseQuestForm(aForm())

    expect(result.outcome).toBe('parsed')
    if (result.outcome !== 'parsed') return
    expect(result.draft['title']).toBe('A thousand registrations')
    expect(result.draft['slots']).toBe(100)
    expect(result.draft['reward']).toEqual({ credits: 1, reputation: 1 })
  })

  /**
   * The rule `#175` closed, kept by something a test can read rather than by a
   * reviewer noticing a new input. If a targeting field is ever added, it has to
   * be added to this list first — and this test is where somebody is asked why.
   */
  it('accepts exactly these fields and no others', () => {
    expect([...QUEST_FORM_FIELDS]).toEqual([
      'title',
      'description',
      'instructions',
      'questions',
      'slots',
      'expiresAt',
      'requires',
      'minReputation',
      'audience',
      'proofVerifier',
      'rewardCredits',
    ])
  })

  it('refuses a field it does not know, rather than dropping it', () => {
    // A silently ignored field is how a targeting input arrives: somebody adds
    // it to the page, the server never refuses it, and it looks like it works.
    expect(problemsOf(aForm({ excludeAgents: 'someone' })).join(' ')).toContain('excludeAgents')
  })

  describe('the rejections a sponsor will actually hit', () => {
    it('refuses a skill the Colony does not mint', () => {
      const problems = problemsOf(aForm({ requires: ['mailbocks'] })).join(' ')

      expect(problems).toContain('mailbocks')
      // The reason, not just the refusal: the quest would look correct and be
      // offered to nobody.
      expect(problems).toContain('offered to')
    })

    it('accepts a skill that is on the list', () => {
      expect(parseQuestForm(aForm({ requires: ['mailbox'] })).outcome).toBe('parsed')
      expect(SKILL_CHOICES).toEqual(KNOWN_SKILLS)
    })

    it('refuses a capacity of zero', () => {
      expect(problemsOf(aForm({ slots: '0' })).join(' ')).toContain('at least 1')
    })

    it('refuses an expiry in the past', () => {
      const past = new Date(Date.now() - 60_000).toISOString()
      expect(problemsOf(aForm({ expiresAt: past })).join(' ')).toContain('already passed')
    })

    it('refuses a question set in which nothing is required', () => {
      const optional = JSON.stringify([
        { key: 'a', prompt: 'Anything?', required: false },
        { key: 'b', prompt: 'Anything else?', required: false },
      ])

      const problems = problemsOf(aForm({ questions: optional })).join(' ')

      expect(problems).toContain('At least one question has to be required')
      // The reason is the money: a report answering nothing still costs escrow.
      expect(problems).toContain('escrow still pays')
    })

    it('refuses a quest with no questions at all', () => {
      expect(problemsOf(aForm({ questions: '[]' })).join(' ')).toContain('at least one question')
    })

    it('refuses a proof verifier the Colony does not have', () => {
      expect(problemsOf(aForm({ proofVerifier: 'vibes' })).join(' ')).toContain('vibes')
    })

    it('refuses an audience outside the two', () => {
      expect(problemsOf(aForm({ audience: 'everyone' })).join(' ')).toContain('citizens')
    })

    it('collects every problem rather than stopping at the first', () => {
      const problems = problemsOf(aForm({ slots: '0', title: 'x', requires: ['nope'] }))

      // A sponsor correcting a form one field per round trip is a sponsor that
      // stops.
      expect(problems.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('the defaults, which are the safe ones', () => {
    it('defaults the audience to citizens when the field is absent', () => {
      const form = aForm()
      delete form['audience']

      const result = parseQuestForm(form)

      expect(result.outcome).toBe('parsed')
      if (result.outcome !== 'parsed') return
      expect(result.draft['audience']).toBe('citizens')
    })

    it('carries a widened audience through to the draft', () => {
      const result = parseQuestForm(aForm({ audience: 'candidates' }))

      expect(result.outcome).toBe('parsed')
      if (result.outcome !== 'parsed') return
      expect(result.draft['audience']).toBe('candidates')
    })

    it('reads "none" and an empty string as no proof verifier', () => {
      for (const value of ['none', '']) {
        const result = parseQuestForm(aForm({ proofVerifier: value }))
        expect(result.outcome).toBe('parsed')
        if (result.outcome !== 'parsed') continue
        expect(result.draft['proofVerifier']).toBeNull()
      }
    })
  })

  describe('what the form says about the two fields with consequences', () => {
    it('names the tier and the cap when no proof is chosen', () => {
      const note = proofNote(null)

      expect(note).toContain('soft')
      expect(note).toContain(String(QUEST_TIER_CAPS.soft))
      // The sentence a sponsor needs at the moment it skips the field.
      expect(note).toContain("citizen's own word")
    })

    it('names the tier and the cap when a verifier is chosen', () => {
      const note = proofNote(QUEST_PROOF_VERIFIERS[0] as string)

      expect(note).toContain('hard')
      expect(note).toContain(String(QUEST_TIER_CAPS.hard))
    })
  })

  describe('what it costs, and whether the balance covers it', () => {
    it('multiplies capacity by price', () => {
      expect(affordability({ slots: 100, credits: 1, available: 500 }).total).toBe(100)
    })

    it('names the shortfall rather than only refusing', () => {
      const money = affordability({ slots: 100, credits: 10, available: 250 })

      expect(money.affordable).toBe(false)
      expect(money.shortfall).toBe(750)
    })

    it('is affordable when the balance exactly covers it', () => {
      expect(affordability({ slots: 10, credits: 5, available: 50 }).affordable).toBe(true)
    })

    it('costs nothing at the pilot price of zero', () => {
      const money = affordability({ slots: 1000, credits: 0, available: 0 })

      expect(money.total).toBe(0)
      expect(money.affordable).toBe(true)
    })
  })
})
