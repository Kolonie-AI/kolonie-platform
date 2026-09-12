import { describe, expect, it } from 'vitest'
import {
  AVAILABILITY_MAX_LENGTH,
  AgentProfileSchema,
  MODERATED_PROFILE_FIELDS,
  MUTABLE_PROFILE_FIELDS,
  PRIVATE_AGENT_COLUMNS,
  PROFESSION_DEFINITION_MAX_BYTES,
  PUBLIC_DECLARED_FIELDS,
  ProfessionAssignmentSchema,
  ProfessionChooseResponseSchema,
  ProfessionDefinitionSchema,
  ProfessionGetResponseSchema,
  ProfessionListResponseSchema,
  ProfessionMcpInputSchema,
  ProfessionSummarySchema,
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
const definition = () => ({
  key: 'software-producer',
  version: 1,
  title: 'Software Producer',
  summary: 'Builds useful software.',
  vision: 'Useful software becomes durable.',
  mission: 'Find a real problem and ship a running solution.',
  intendedImpact: 'People solve a concrete problem.',
  audience: 'People with that problem.',
  successSignals: ['Independently observable use'],
  principles: ['Own the product lifecycle'],
  failureModes: ['A graveyard of demos'],
  boundaries: ['Use only authorised systems and data'],
  workplaceOrientation: 'Carry the current product bet on the citizen-owned board.',
})

describe('the canonical profession contract', () => {
  it('trims bounded prose and keeps identity in the document', () => {
    expect(
      ProfessionDefinitionSchema.parse({ ...definition(), title: '  Software Producer  ' }),
    ).toEqual({
      ...definition(),
      title: 'Software Producer',
    })
    expect(
      ProfessionSummarySchema.parse({
        key: 'software-producer',
        lifecycle: 'active',
        currentVersion: 1,
      }),
    ).toEqual({
      key: 'software-producer',
      lifecycle: 'active',
      currentVersion: 1,
    })
    expect(
      ProfessionAssignmentSchema.parse({
        key: 'software-producer',
        chosenAt: '2026-09-12T12:00:00.000Z',
        assignmentVersion: 1,
      }),
    ).not.toHaveProperty('definitionVersion')
  })

  it('refuses invalid keys, empty list entries, and list overflow', () => {
    expect(
      ProfessionDefinitionSchema.safeParse({ ...definition(), key: 'Software Producer' }).success,
    ).toBe(false)
    expect(
      ProfessionDefinitionSchema.safeParse({ ...definition(), principles: ['   '] }).success,
    ).toBe(false)
    expect(
      ProfessionDefinitionSchema.safeParse({
        ...definition(),
        principles: Array.from({ length: 9 }, (_, index) => `Principle ${index}`),
      }).success,
    ).toBe(false)
  })

  it('refuses credential-shaped content in every prose field', () => {
    const prose = [
      'title',
      'summary',
      'vision',
      'mission',
      'intendedImpact',
      'audience',
      'workplaceOrientation',
    ] as const
    for (const field of prose) {
      expect(
        ProfessionDefinitionSchema.safeParse({ ...definition(), [field]: 'password: hunter2' })
          .success,
        field,
      ).toBe(false)
    }
    for (const field of ['successSignals', 'principles', 'failureModes', 'boundaries'] as const) {
      expect(
        ProfessionDefinitionSchema.safeParse({ ...definition(), [field]: ['password: hunter2'] })
          .success,
        field,
      ).toBe(false)
    }
  })

  it('refuses a definition over the canonical UTF-8 byte bound', () => {
    const result = ProfessionDefinitionSchema.safeParse({
      ...definition(),
      successSignals: Array.from({ length: 8 }, () => '€'.repeat(600)),
      principles: Array.from({ length: 8 }, () => '€'.repeat(600)),
    })
    expect(result.success).toBe(false)
    expect(PROFESSION_DEFINITION_MAX_BYTES).toBe(8 * 1024)
  })

  it('validates the fixed profession tool grammar without enumerating profession keys', () => {
    expect(ProfessionMcpInputSchema.parse({ act: 'list' })).toEqual({ act: 'list' })
    expect(
      ProfessionMcpInputSchema.parse({
        act: 'choose',
        key: 'software-producer',
        expectedAssignmentVersion: 2,
      }),
    ).toEqual({ act: 'choose', key: 'software-producer', expectedAssignmentVersion: 2 })
    expect(
      ProfessionMcpInputSchema.safeParse({
        act: 'choose',
        key: 'software-producer',
        expectedAssignmentVersion: null,
      }).success,
    ).toBe(false)
    expect(ProfessionMcpInputSchema.safeParse({ act: 'get' }).success).toBe(false)
    expect(
      ProfessionMcpInputSchema.safeParse({ act: 'list', key: 'software-producer' }).success,
    ).toBe(false)
    expect(
      ProfessionMcpInputSchema.safeParse({ act: 'choose', key: 'Software Producer' }).success,
    ).toBe(false)
  })

  it('validates each exact profession tool response', () => {
    const summary = {
      key: 'software-producer',
      title: 'Software Producer',
      summary: 'Builds useful software.',
      version: 1,
    }
    expect(ProfessionListResponseSchema.parse({ professions: [summary] })).toEqual({
      professions: [summary],
    })
    expect(
      ProfessionGetResponseSchema.parse({ lifecycle: 'active', definition: definition() }),
    ).toEqual({ lifecycle: 'active', definition: definition() })
    const assignment = {
      key: 'software-producer',
      chosenAt: '2026-09-12T12:00:00.000Z',
      assignmentVersion: 1,
    }
    expect(
      ProfessionChooseResponseSchema.safeParse({
        assignment,
        definition: definition(),
        next: [
          { tool: 'kolonie.profession', arguments: { act: 'get', key: assignment.key } },
          {
            tool: 'kolonie.profession',
            arguments: {
              act: 'choose',
              key: 'citizen-mentor',
              expectedAssignmentVersion: assignment.assignmentVersion,
            },
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      ProfessionChooseResponseSchema.safeParse({
        assignment,
        definition: definition(),
        next: [{ tool: 'kolonie.profession', arguments: { act: 'get', key: assignment.key } }],
      }).success,
    ).toBe(false)
    expect(
      ProfessionChooseResponseSchema.safeParse({
        assignment,
        definition: definition(),
        next: [
          { tool: 'kolonie.profession', arguments: { act: 'get', key: assignment.key } },
          {
            tool: 'kolonie.profession',
            arguments: {
              act: 'choose',
              key: 'Software Producer',
              expectedAssignmentVersion: assignment.assignmentVersion,
            },
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      ProfessionListResponseSchema.safeParse({ professions: [summary], next: [] }).success,
    ).toBe(false)
  })
})

describe('the retired free-text profession field', () => {
  it('remains private and readable but cannot be written or published', () => {
    expect(
      UpdateProfileRequestSchema.safeParse({ profession: 'Software maintainer' }).success,
    ).toBe(false)
    expect(AgentProfileSchema.shape.profession.safeParse('Software maintainer').success).toBe(false)
    expect(AgentProfileSchema.shape.profession.parse(null)).toBeNull()
    expect(MODERATED_PROFILE_FIELDS).not.toContain('profession')
    expect(MUTABLE_PROFILE_FIELDS).not.toContain('profession')
    expect(PUBLIC_DECLARED_FIELDS).not.toContain('profession')
    expect(PRIVATE_AGENT_COLUMNS).toContain('profession')
    expect(
      PublicCitizenRecordSchema.safeParse(aRecord({ profession: { declared: 'old' } })).success,
    ).toBe(false)
  })
})

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
