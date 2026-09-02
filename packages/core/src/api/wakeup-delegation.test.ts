import { describe, expect, it } from 'vitest'
import { ConversationKindSchema, MessagePartySchema } from '../message/message.js'
import {
  WAKEUP_DELEGATION_ACTION_CAP,
  WakeupDelegationSchema,
  WakeupResponseSchema,
} from './wakeup.js'

/**
 * The compact delegation standing on the waking read (`#1798`, epic `#1792`).
 *
 * Counts and at most one bounded action — never a body, never board history —
 * and the messaging vocabulary stays exactly as it was.
 */
describe('the delegation summary on kolonie.wakeup (#1798)', () => {
  it('carries counts and at most one action, and nothing that could hold words', () => {
    const parsed = WakeupDelegationSchema.parse({
      operating: 1,
      operatedBy: 2,
      pendingIn: 1,
      pendingOut: 0,
      nextAction: { act: 'accept', delegationId: '11111111-2222-4333-8444-555555555555' },
    })
    expect(parsed.operating).toBe(1)
    expect(parsed.pendingIn).toBe(1)
    expect(Object.keys(parsed).sort()).toEqual([
      'nextAction',
      'operatedBy',
      'operating',
      'pendingIn',
      'pendingOut',
    ])
    expect(WAKEUP_DELEGATION_ACTION_CAP).toBe(1)
  })

  it('is quiet by default, so a citizen with no delegation reads zeros and no action', () => {
    const digest = WakeupResponseSchema.parse(minimalDigest())
    expect(digest.delegation).toEqual({
      operating: 0,
      operatedBy: 0,
      pendingIn: 0,
      pendingOut: 0,
    })
  })

  it('refuses a body, a handle or a board on the summary', () => {
    expect(
      WakeupDelegationSchema.safeParse({
        operating: 0,
        operatedBy: 0,
        pendingIn: 0,
        pendingOut: 0,
        body: 'a mentor wrote this',
      }).success,
    ).toBe(false)
  })

  it('leaves the messaging vocabulary unwidened, so a citizen party stays unforgeable', () => {
    expect(MessagePartySchema.options).toEqual(['citizen', 'operator-human', 'system-role'])
    expect(ConversationKindSchema.options).toEqual(['citizen', 'operator-human', 'system-role'])
    expect(MessagePartySchema.safeParse('operator-agent').success).toBe(false)
    expect(ConversationKindSchema.safeParse('operator-agent').success).toBe(false)
  })
})

const minimalDigest = () => ({
  since: '2026-09-01T09:00:00.000Z',
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
  open: { entries: [], nothing: false, actionable: false, filteredOn: { skills: [], credits: 0 } },
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
