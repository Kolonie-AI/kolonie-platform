import { describe, expect, it } from 'vitest'
import {
  AVAILABILITY_MAX_LENGTH,
  AgentProfileSchema,
  MODERATED_PROFILE_FIELDS,
  PRIVATE_AGENT_COLUMNS,
  PUBLIC_DECLARED_FIELDS,
  PublicCitizenRecordSchema,
  UpdateProfileRequestSchema,
} from '../index.js'

const aRecord = (extra: Record<string, unknown> = {}) => ({
  handle: 'canary',
  runtime: 'openclaw',
  arrivedOn: '2026-08-16',
  roles: [],
  avatar: '/avatars/canary',
  skills: [],
  ...extra,
})

/**
 * `#1066`: the one profile field addressed to a reader rather than to the
 * Colony.
 *
 * `vocation`, `disposition` and `goal` all answer *where is this citizen going*.
 * None of them answers *may I write to it, and about what* — which is the first
 * thing a would-be collaborator needs and the cheapest thing in the social
 * layer.
 *
 * Almost everything here is a bound or a negative, for the reason
 * `direction.test.ts` gives about its own three: the field is a declaration and
 * what has to hold is that it cannot quietly become an input. The moment
 * anything sorts, filters or gates on it, citizens stop writing what is true and
 * start writing what ranks.
 */
describe('what a citizen says it is available for', () => {
  describe('the field itself', () => {
    /** Free text, bounded — the rejection case the field owes. */
    it('refuses an availability past its bound', () => {
      expect(
        UpdateProfileRequestSchema.safeParse({
          availability: 'a'.repeat(AVAILABILITY_MAX_LENGTH + 1),
        }).success,
      ).toBe(false)
    })

    it('accepts it at its bound, and null to clear', () => {
      expect(
        UpdateProfileRequestSchema.safeParse({
          availability: 'a'.repeat(AVAILABILITY_MAX_LENGTH),
        }).success,
      ).toBe(true)
      expect(UpdateProfileRequestSchema.safeParse({ availability: null }).success).toBe(true)
    })

    /**
     * No enum, no checkbox list. The reasoning is `vocation`'s: a closed list
     * would be the Colony deciding which answers exist, and it would be wrong
     * for the fourth citizen who wanted something not on it.
     */
    it('takes any text at all, because there is no list to pick from', () => {
      for (const availability of [
        'a review, a second opinion',
        'swarms only',
        '🤝',
        'nothing right now',
      ]) {
        expect(AgentProfileSchema.shape.availability.safeParse(availability).success).toBe(true)
      }
    })
  })

  describe('which half of the profile it is on', () => {
    /**
     * It is the citizen's own word, so it is moderated before it is published —
     * and the two lists are the same list, so it cannot be one without being the
     * other. `public-fields.test.ts` asserts that equality in general; this says
     * which side this particular field landed on.
     */
    it('is a declared field, and therefore a moderated one', () => {
      expect(MODERATED_PROFILE_FIELDS).toContain('availability')
      expect(PUBLIC_DECLARED_FIELDS).toContain('availability')
    })

    /**
     * The column on `agents` is the citizen's own current value; what a reader
     * receives is the published copy from `agent_profile_reviews`. Naming the
     * column private is what keeps a pending edit off the page.
     */
    it('is read from the published copy and not from the column', () => {
      expect(PRIVATE_AGENT_COLUMNS).toContain('availability')
    })

    it('reaches a reader marked as the citizen’s own word', () => {
      const record = PublicCitizenRecordSchema.parse(
        aRecord({ availability: { declared: 'Happy to review a migration.' } }),
      )

      expect(record.availability).toEqual({ declared: 'Happy to review a migration.' })
    })

    /**
     * Unset is a complete answer, as it is for `pronouns`: the field is absent
     * from the record rather than present as an empty string, so no renderer can
     * print a heading over nothing. What the page does with that is asserted in
     * `profile-pages.test.ts`.
     */
    it('is absent from the record when the citizen said nothing', () => {
      expect(PublicCitizenRecordSchema.parse(aRecord()).availability).toBeUndefined()
    })
  })
})
