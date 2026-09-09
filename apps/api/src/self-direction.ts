import type { SelfDirectionClose, SelfDirectionResponse } from '@kolonie-ai/core'
import {
  closeSelfDirectionAttempt,
  listSelfDirectionHistory,
  readSelfDirectionAttempt,
  readSelfDirectionItemStatistics,
  startSelfDirectionAttempt,
  submitSelfDirectionResponses,
  type Database,
  type SelfDirectionAttemptView,
  type SelfDirectionHistoryEntry,
  type SelfDirectionItemReport,
} from '@kolonie-ai/db'

/**
 * The self-direction practice, as a port (`#1892`).
 *
 * One port for the whole loop because one tool serves it: an act is an argument
 * rather than a namespace, so a second port would buy a second wiring for the
 * same five calls.
 */
export interface SelfDirectionPractice {
  start(agentId: string, delegationId?: string): Promise<SelfDirectionAttemptView>
  read(agentId: string): Promise<SelfDirectionAttemptView | null>
  submit(
    agentId: string,
    attemptId: string,
    responses: readonly SelfDirectionResponse[],
  ): Promise<SelfDirectionAttemptView>
  close(
    agentId: string,
    attemptId: string,
    input: SelfDirectionClose,
  ): Promise<SelfDirectionAttemptView>
  history(agentId: string, limit?: number): Promise<readonly SelfDirectionHistoryEntry[]>
}

/**
 * The maintainer's aggregate read (`#1895`), a port of its own.
 *
 * Separate from {@link SelfDirectionPractice} because the reader is different:
 * that one answers a citizen about itself, this one answers a person about the
 * questions. Keeping them apart is what makes it impossible to wire the
 * aggregate into a citizen surface by accident.
 */
export interface SelfDirectionStatistics {
  items(): Promise<SelfDirectionItemReport>
}

export function databaseSelfDirectionStatistics(db: Database): SelfDirectionStatistics {
  return { items: () => readSelfDirectionItemStatistics(db) }
}

export function databaseSelfDirectionPractice(db: Database): SelfDirectionPractice {
  return {
    start: (agentId, delegationId) =>
      startSelfDirectionAttempt(db, agentId, delegationId === undefined ? {} : { delegationId }),
    read: (agentId) => readSelfDirectionAttempt(db, agentId),
    submit: (agentId, attemptId, responses) =>
      submitSelfDirectionResponses(db, agentId, attemptId, responses),
    close: (agentId, attemptId, input) => closeSelfDirectionAttempt(db, agentId, attemptId, input),
    history: (agentId, limit) => listSelfDirectionHistory(db, agentId, limit),
  }
}
