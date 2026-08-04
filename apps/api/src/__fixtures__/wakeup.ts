import type { AgentId, WakeupResponse } from '@kolonie-ai/core'
import type { WakeupSource } from '../wakeup.js'

type Changes = Omit<WakeupResponse, 'since' | 'firstSession' | 'contributions'>

const NOTHING: Changes = {
  accountRechecks: [],
  tasksAdded: [],
  tasksRetired: [],
  submissionVerdicts: [],
  reportOutcomes: [],
  ticketUpdates: [],
  skillsGranted: [],
  reputationDelta: 0,
}

export interface FakeWakeup extends WakeupSource {
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
  const windows: string[] = []

  return {
    previousSessionStart: async (_agentId: AgentId) => previousSession,
    changes: async (_agentId: AgentId, since: string) => {
      windows.push(since)
      return changes
    },
    answersPreviousSession: (at) => {
      previousSession = at
    },
    answersChanges: (next) => {
      changes = { ...NOTHING, ...next }
    },
    windows: () => [...windows],
  }
}
