import { describe, expect, it } from 'vitest'
import { GOAL_MAX_LENGTH, PROFESSION_MAX_LENGTH } from '../agent/agent.js'
import { SESSION_ID_MAX_LENGTH } from '../agent/session.js'
import {
  SKILL_NOTE_PREVIEW_MAX_LENGTH,
  SKILL_NOTES_PREVIEW_TOTAL_MAX_LENGTH,
  skillNotePreview,
  WakeupCapabilityNoteSchema,
  WakeupGuestVaultHandoffEventSchema,
  WakeupIdentitySchema,
  WakeupRequestSchema,
  WakeupResponseSchema,
  WakeupSponsoredQuestSchema,
  WakeupWorkplaceSchema,
} from './wakeup.js'

describe('a skill note projected into wake-up', () => {
  const entry = {
    skill: 'browser',
    preview: 'Start it headless.',
    truncated: false,
    writtenAt: '2026-09-02T09:00:00.000Z',
    full: { tool: 'kolonie.skills.note', arguments: { skill: 'browser' } },
  }

  it('accepts a bounded preview with the exact full-read call', () => {
    expect(WakeupCapabilityNoteSchema.parse(entry)).toEqual(entry)
    expect(SKILL_NOTES_PREVIEW_TOTAL_MAX_LENGTH).toBe(720)
  })

  it('rejects the stored full-note shape and an overlong preview', () => {
    expect(
      WakeupCapabilityNoteSchema.safeParse({
        skill: 'browser',
        note: 'full stored note',
        writtenAt: entry.writtenAt,
      }).success,
    ).toBe(false)
    expect(
      WakeupCapabilityNoteSchema.safeParse({
        ...entry,
        preview: 'x'.repeat(SKILL_NOTE_PREVIEW_MAX_LENGTH + 1),
      }).success,
    ).toBe(false)
  })

  it('rejects mismatched full-read arguments and an aggregate over the response bound', () => {
    expect(
      WakeupCapabilityNoteSchema.safeParse({
        ...entry,
        full: { tool: 'kolonie.skills.note', arguments: { skill: 'mailbox' } },
      }).success,
    ).toBe(false)

    const digest = {
      since: '2026-08-01T09:00:00.000Z',
      firstSession: false,
      identity: { profession: null, goal: null },
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
      capabilityNotes: Array.from({ length: 4 }, (_, index) => ({
        ...entry,
        skill: `skill-${index}`,
        preview: 'x'.repeat(SKILL_NOTE_PREVIEW_MAX_LENGTH),
        full: { tool: 'kolonie.skills.note', arguments: { skill: `skill-${index}` } },
      })),
      capabilityNotesOmitted: 0,
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
    }

    expect(WakeupResponseSchema.safeParse(digest).success).toBe(false)
  })

  it('keeps a short note unchanged and marks a longer note truncated', () => {
    expect(skillNotePreview('short note')).toEqual({ preview: 'short note', truncated: false })
    expect(skillNotePreview('x'.repeat(SKILL_NOTE_PREVIEW_MAX_LENGTH + 1))).toEqual({
      preview: 'x'.repeat(SKILL_NOTE_PREVIEW_MAX_LENGTH),
      truncated: true,
    })
  })

  it('never splits a Unicode grapheme at the boundary', () => {
    const family = '👨\u200d👩\u200d👧\u200d👦'
    const combined = 'e\u0301'
    const prefix = 'x'.repeat(SKILL_NOTE_PREVIEW_MAX_LENGTH - 1)

    expect(skillNotePreview(`${prefix}${family}after`)).toEqual({
      preview: prefix,
      truncated: true,
    })
    expect(skillNotePreview(`${prefix}${combined}after`)).toEqual({
      preview: prefix,
      truncated: true,
    })
  })
})

describe('a terminal guest vault handoff in wake-up', () => {
  const event = {
    handoffId: '11111111-1111-4111-8111-111111111111',
    vaultKey: 'credential/machine',
    purpose: 'deliver the machine credential',
    state: 'consumed',
    at: '2026-09-03T10:00:00.000Z',
  }

  it('accepts only the creator-facing lifecycle fields', () => {
    expect(WakeupGuestVaultHandoffEventSchema.parse(event)).toEqual(event)
  })

  it('rejects active handoffs and capability or recipient data', () => {
    expect(
      WakeupGuestVaultHandoffEventSchema.safeParse({ ...event, state: 'active' }).success,
    ).toBe(false)
    for (const state of ['consumed', 'expired', 'revoked']) {
      expect(WakeupGuestVaultHandoffEventSchema.parse({ ...event, state }).state).toBe(state)
    }
    expect(
      WakeupGuestVaultHandoffEventSchema.safeParse({
        ...event,
        bearerToken: 'not-returned',
        passphrase: 'not-returned',
        recipientIdentity: 'not-inferred',
      }).success,
    ).toBe(false)
  })
})

describe('the session a wakeup-first citizen may declare', () => {
  it('accepts the same three optional fields kolonie.me takes', () => {
    expect(
      WakeupRequestSchema.parse({
        sessionId: 'run-1',
        tokens: 4200,
        runtimeTools: ['bash', 'read'],
      }),
    ).toEqual({
      sessionId: 'run-1',
      tokens: 4200,
      runtimeTools: ['bash', 'read'],
    })
  })

  it('keeps an empty tool list distinct from an absent one', () => {
    expect(Object.hasOwn(WakeupRequestSchema.parse({ runtimeTools: [] }), 'runtimeTools')).toBe(
      true,
    )
    expect(Object.hasOwn(WakeupRequestSchema.parse({}), 'runtimeTools')).toBe(false)
  })

  it('refuses a session id longer than the bound rather than truncating it', () => {
    expect(
      WakeupRequestSchema.safeParse({ sessionId: 'x'.repeat(SESSION_ID_MAX_LENGTH + 1) }).success,
    ).toBe(false)
    expect(
      WakeupRequestSchema.safeParse({ sessionId: 'x'.repeat(SESSION_ID_MAX_LENGTH) }).success,
    ).toBe(true)
  })
})

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
      capabilityNotesOmitted: 0,
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

describe('the Workplace handoff in wake-up', () => {
  const boardId = '11111111-2222-4333-8444-555555555555'
  const cardId = '66666666-7777-4888-8999-000000000000'

  it('accepts one bounded recommendation as an exact Workplace call', () => {
    expect(
      WakeupWorkplaceSchema.parse({
        boardId,
        recommendation: {
          cardId,
          title: 'Plan the first workday',
          status: 'inbox',
          next: {
            tool: 'kolonie.workplace',
            arguments: { act: 'get', subject: 'card', id: cardId },
          },
        },
        more: [],
      }),
    ).toMatchObject({ boardId, recommendation: { cardId } })
  })

  it('rejects a board dump and card bodies', () => {
    const more = Array.from({ length: 5 }, (_, index) => ({
      cardId: `00000000-0000-4000-8000-00000000000${index}`,
      status: 'ready',
    }))
    expect(WakeupWorkplaceSchema.safeParse({ boardId, recommendation: null, more }).success).toBe(
      false,
    )
    expect(
      WakeupWorkplaceSchema.safeParse({
        boardId,
        recommendation: {
          cardId,
          title: 'Plan the first workday',
          description: 'body must stay on card detail',
          status: 'inbox',
          next: {
            tool: 'kolonie.workplace',
            arguments: { act: 'get', subject: 'card', id: cardId },
          },
        },
        more: [],
      }).success,
    ).toBe(false)
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
