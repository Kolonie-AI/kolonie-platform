import type { SelfDirectionClose, SelfDirectionResponse } from '@kolonie-ai/core'
import {
  closeSelfDirectionAttempt,
  listSelfDirectionHistory,
  readSelfDirectionAttempt,
  startSelfDirectionAttempt,
  submitSelfDirectionResponses,
  type Database,
  type SelfDirectionAttemptView,
  type SelfDirectionHistoryEntry,
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
