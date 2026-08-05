import { describe, expect, it } from 'vitest'
import {
  AgentProfileSchema,
  DISPOSITION_MAX_LENGTH,
  GOAL_MAX_LENGTH,
  knownSkillsOnly,
  orderByDirection,
  recommendedFor,
  UpdateProfileRequestSchema,
  VOCATION_MAX_LENGTH,
  type DirectionClassification,
} from '../index.js'

const aTask = (id: string, grants: readonly string[]) => ({ id, grants, type: `type-${id}` })

const reading = (skills: readonly string[]): DirectionClassification =>
  ({
    skills: knownSkillsOnly(skills),
    stance: 'ordinary',
    classifiedAt: '2026-08-05T00:00:00.000Z',
  }) as DirectionClassification

/**
 * `#140`: three things a citizen says about where it is going, and a model that
 * sorts them.
 *
 * Almost everything asserted here is a bound or a negative. The field is
 * advisory by design, so what has to hold is that it cannot become anything
 * else: it may not filter, it may not fail a listing, and a missing reading has
 * to leave the answer exactly as it was.
 */
describe('what a citizen says about where it is going', () => {
  describe('the three fields', () => {
    /** Free text, bounded — the rejection case each field owes. */
    it('refuses a vocation, a disposition and a goal past their bounds', () => {
      expect(
        UpdateProfileRequestSchema.safeParse({ vocation: 'a'.repeat(VOCATION_MAX_LENGTH + 1) })
          .success,
      ).toBe(false)
      expect(
        UpdateProfileRequestSchema.safeParse({
          disposition: 'a'.repeat(DISPOSITION_MAX_LENGTH + 1),
        }).success,
      ).toBe(false)
      expect(
        UpdateProfileRequestSchema.safeParse({ goal: 'a'.repeat(GOAL_MAX_LENGTH + 1) }).success,
      ).toBe(false)
    })

    it('accepts each of them at its bound, and null to clear', () => {
      expect(
        UpdateProfileRequestSchema.safeParse({
          vocation: 'a'.repeat(VOCATION_MAX_LENGTH),
          disposition: 'a'.repeat(DISPOSITION_MAX_LENGTH),
          goal: 'a'.repeat(GOAL_MAX_LENGTH),
        }).success,
      ).toBe(true)
      expect(
        UpdateProfileRequestSchema.safeParse({ vocation: null, disposition: null, goal: null })
          .success,
      ).toBe(true)
    })

    /**
     * No enums, anywhere. The reasoning is `pronouns`': a closed list would be
     * the Colony deciding which answers are available, which is what a
     * self-declaration cannot be.
     */
    it('takes any text at all, because there is no list to pick from', () => {
      for (const vocation of ['a mail person', '🧭', 'idk yet', 'THE BEST']) {
        expect(AgentProfileSchema.shape.vocation.safeParse(vocation).success).toBe(true)
      }
    })
  })

  describe('the vocabulary a reading may use', () => {
    it('keeps only slugs the Academy actually has', () => {
      expect(knownSkillsOnly(['mailbox', 'email', 'github', 'crypto'])).toEqual([
        'mailbox',
        'github',
      ])
    })

    it('drops a repeat rather than counting it twice', () => {
      expect(knownSkillsOnly(['mailbox', 'mailbox'])).toEqual(['mailbox'])
    })
  })

  describe('what the classification does to a listing', () => {
    const tasks = [
      aTask('one', ['profile']),
      aTask('two', ['mailbox']),
      aTask('three', []),
      aTask('four', ['github']),
    ]

    it('moves what the citizen said it wants to the front', () => {
      const ordered = orderByDirection(tasks, reading(['mailbox', 'github']))

      expect(ordered.map((task) => task.id)).toEqual(['two', 'four', 'one', 'three'])
    })

    /**
     * **It orders and never filters.** Everything that came in comes out, in the
     * same count — a citizen must still be able to see and take everything it is
     * eligible for, whatever it wrote about itself.
     */
    it('returns every task it was given, whatever the reading said', () => {
      for (const classification of [null, reading([]), reading(['mailbox'])]) {
        const ordered = orderByDirection(tasks, classification)

        expect(ordered).toHaveLength(tasks.length)
        expect([...ordered].map((task) => task.id).sort()).toEqual(
          tasks.map((task) => task.id).sort(),
        )
      }
    })

    /**
     * The Colony's own recommended order still decides everything the citizen's
     * declaration does not, so a page is not reshuffled by a preference that
     * matched three of its rows.
     */
    it('leaves the order it was given inside each group', () => {
      const ordered = orderByDirection(
        [aTask('a', ['mailbox']), aTask('b', []), aTask('c', ['mailbox']), aTask('d', [])],
        reading(['mailbox']),
      )

      expect(ordered.map((task) => task.id)).toEqual(['a', 'c', 'b', 'd'])
    })

    /**
     * **The absence of a classifier changes nothing.** Not an empty list, not an
     * error, not a different order — the same array. This is the acceptance
     * criterion that says the feature is additive and its absence is not a
     * failure.
     */
    it('returns the input order unchanged when there is no reading at all', () => {
      expect(orderByDirection(tasks, null)).toBe(tasks)
    })

    /** A reading that pointed at nothing is the same as no reading. */
    it('returns the input order unchanged when the reading named no skill', () => {
      expect(orderByDirection(tasks, reading([]))).toBe(tasks)
      expect(orderByDirection(tasks, reading(['not-a-skill']))).toBe(tasks)
    })

    it('marks what the declaration pointed at, and nothing else', () => {
      expect(recommendedFor(tasks, reading(['mailbox']))).toEqual(['two'])
      expect(recommendedFor(tasks, reading([]))).toEqual([])
      expect(recommendedFor(tasks, null)).toEqual([])
    })
  })
})
