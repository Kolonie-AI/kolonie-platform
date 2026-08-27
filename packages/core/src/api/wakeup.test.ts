import { describe, expect, it } from 'vitest'
import { GOAL_MAX_LENGTH, PROFESSION_MAX_LENGTH } from '../agent/agent.js'
import { WakeupIdentitySchema, WakeupResponseSchema, WakeupSponsoredQuestSchema } from './wakeup.js'

describe('a citizen’s wake-up identity', () => {
  it('accepts the citizen’s current self-declaration', () => {
    expect(
      WakeupIdentitySchema.safeParse({
        profession: 'Software maintainer',
        goal: 'Make account acquisition repeatable.',
      }).success,
    ).toBe(true)
  })

  it('keeps classifications out of the citizen’s own words', () => {
    expect(
      WakeupIdentitySchema.parse({
        profession: 'Software maintainer',
        goal: 'Make account acquisition repeatable.',
        vocationSkills: ['mailbox'],
        dispositionStance: 'ordinary',
      }),
    ).toEqual({
      profession: 'Software maintainer',
      goal: 'Make account acquisition repeatable.',
    })
  })

  it('rejects either sentence past its canonical profile bound', () => {
    expect(
      WakeupIdentitySchema.safeParse({
        profession: 'a'.repeat(PROFESSION_MAX_LENGTH + 1),
        goal: null,
      }).success,
    ).toBe(false)
    expect(
      WakeupIdentitySchema.safeParse({
        profession: null,
        goal: 'a'.repeat(GOAL_MAX_LENGTH + 1),
      }).success,
    ).toBe(false)
  })

  it('defaults an older payload to unset rather than inventing a profession', () => {
    const parsed = WakeupResponseSchema.parse({
      since: '2026-08-01T09:00:00.000Z',
      firstSession: false,
      standing: { skillsHeld: [], skillsGrantable: 0, reputation: 0 },
      accountRechecks: [],
      tasksAdded: [],
      tasksRetired: [],
      rungsRevised: [],
      submissionVerdicts: [],
      reportOutcomes: [],
      ticketUpdates: [],
      skillsGranted: [],
      rolesGranted: [],
      rolesRevoked: [],
      autonomyRevisions: [],
      reputationDelta: 0,
      noteInvitations: [],
      walkInvitations: [],
      capabilityNotes: [],
      open: {
        entries: [],
        nothing: false,
        actionable: false,
        filteredOn: { skills: [], credits: 0 },
      },
      actionableNow: false,
      contributions: { pullRequests: [], unavailable: null },
      operatorNotesUnread: 0,
      operatorRepliesWaiting: 0,
      wakeChannel: null,
      suspension: null,
      operatorStanding: {
        consoleLink: { status: 'none', linkedAt: null, reachable: false },
        pages: { live: 0, lastIssuedAt: null, lastOpenedAt: null },
        publicClaim: { status: 'none', handle: null, claimedAt: null },
      },
      accountsWanted: [],
    })
    expect(parsed.identity).toEqual({ profession: null, goal: null })
  })
})

describe('a sponsored quest in the wake-up digest', () => {
  it('accepts the invoice state the sponsor must act on', () => {
    expect(
      WakeupSponsoredQuestSchema.safeParse({
        taskId: '11111111-1111-4111-8111-111111111111',
        title: 'Measure the registration path',
        transition: 'awaiting_payment',
        changedAt: '2026-08-01T10:00:00.000Z',
        invoiceLamports: 2_000_000,
      }).success,
    ).toBe(true)
  })

  it('rejects a transition the digest does not promise', () => {
    expect(
      WakeupSponsoredQuestSchema.safeParse({
        taskId: '11111111-1111-4111-8111-111111111111',
        title: 'Measure the registration path',
        transition: 'pending_review',
        changedAt: '2026-08-01T10:00:00.000Z',
      }).success,
    ).toBe(false)
  })
})
