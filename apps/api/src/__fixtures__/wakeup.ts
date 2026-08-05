import type { AgentId, WakeupResponse, WakeupStanding } from '@kolonie-ai/core'
import type { WakeupSource } from '../wakeup.js'

type Changes = Omit<
  WakeupResponse,
  | 'since'
  | 'firstSession'
  | 'contributions'
  | 'operatorNotesUnread'
  | 'open'
  | 'standing'
  | 'pays'
  // Computed by `wakeup` from `skillsGranted` and the note store, never by the
  // source (`#377`).
  | 'noteInvitations'
>

/** A citizen at the very start: nothing held, nothing earned (`#344`). */
const AT_THE_START: WakeupStanding = { skillsHeld: [], skillsGrantable: 0, reputation: 0 }

const NOTHING: Changes = {
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
  reputationDelta: 0,
}

export interface FakeWakeup extends WakeupSource {
  /** How many unread operator notes the digest should report (#239). */
  readonly answersUnreadNotes: (count: number) => void
  /** What the previous session's start should answer. `null` is "first session". */
  readonly answersPreviousSession: (at: string | null) => void
  /** Where the citizen stands, for the section that says so (`#344`). */
  readonly answersStanding: (standing: WakeupStanding) => void
  readonly answersChanges: (changes: Partial<Changes>) => void
  /** The windows the digest was asked about, so a test can assert the derivation. */
  readonly windows: () => readonly string[]
}

/**
 * A digest source that answers with what it was told (#200).
 *
 * It records the `since` it was asked for, because the derivation — *the session
 * before the current one* — is the part of this call a route can get wrong
 * without any field looking wrong.
 */
export function fakeWakeup(): FakeWakeup {
  let previousSession: string | null = null
  let changes: Changes = NOTHING
  let unread = 0
  let standing: WakeupStanding = AT_THE_START
  const windows: string[] = []

  return {
    previousSessionStart: async (_agentId: AgentId) => previousSession,
    unreadOperatorNotes: async (_agentId: AgentId) => unread,
    standing: async (_agentId: AgentId) => standing,
    changes: async (_agentId: AgentId, since: string) => {
      windows.push(since)
      return changes
    },
    answersPreviousSession: (at) => {
      previousSession = at
    },
    answersUnreadNotes: (count) => {
      unread = count
    },
    answersStanding: (next) => {
      standing = next
    },
    answersChanges: (next) => {
      changes = { ...NOTHING, ...next }
    },
    windows: () => [...windows],
  }
}
