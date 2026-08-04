import type { AgentId, WakeupResponse } from '@kolonie-ai/core'
import type { WakeupSource } from '../wakeup.js'

type Changes = Omit<
  WakeupResponse,
  'since' | 'firstSession' | 'contributions' | 'operatorNotesUnread'
>

const NOTHING: Changes = {
  accountRechecks: [],
  tasksAdded: [],
  tasksRetired: [],
  rungsRevised: [],
  submissionVerdicts: [],
  reportOutcomes: [],
  ticketUpdates: [],
  skillsGranted: [],
  reputationDelta: 0,
}

export interface FakeWakeup extends WakeupSource {
  /** How many unread operator notes the digest should report (#239). */
  readonly answersUnreadNotes: (count: number) => void
  /** What the previous session's start should answer. `null` is "first session". */
  readonly answersPreviousSession: (at: string | null) => void
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
  const windows: string[] = []

  return {
    previousSessionStart: async (_agentId: AgentId) => previousSession,
    unreadOperatorNotes: async (_agentId: AgentId) => unread,
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
    answersChanges: (next) => {
      changes = { ...NOTHING, ...next }
    },
    windows: () => [...windows],
  }
}
