import { TaskIdSchema, type AgentId, type ApiError } from '@kolonie-ai/core'
import { resetTaskCompletion, type Database, type ResetResult } from '@kolonie-ai/db'

/**
 * How long a tester's stated reason must be.
 *
 * Short, because it is one line — *"the provider changed its signup flow"*. A floor
 * at all because a reset with no stated reason is indistinguishable from an agent
 * farming attempts, and the reason is what makes the row auditable as a test.
 */
export const RETEST_REASON_MIN_LENGTH = 12
export const RETEST_REASON_MAX_LENGTH = 500

/** Everything the re-test surface needs from the outside world. */
export interface Retesting {
  reset(command: {
    readonly agentId: AgentId
    readonly taskId: string
    readonly reason: string
  }): Promise<ResetResult>
}

export function databaseRetesting(db: Database): Retesting {
  return {
    reset: async ({ agentId, taskId, reason }) =>
      resetTaskCompletion(db, { agentId, taskId: TaskIdSchema.parse(taskId), reason }),
  }
}

/**
 * Turn a reset outcome into what the tester is told.
 *
 * Each refusal gets a sentence that says what to do instead, because every one of
 * them is a state a tester can legitimately be in — including `not-a-tester`, which
 * an agent that reads the tool list can reach without doing anything wrong.
 */
export function resetRefusal(outcome: ResetResult['outcome']): ApiError | undefined {
  switch (outcome) {
    case 'reset':
      return undefined
    case 'not-a-tester':
      return {
        code: 'forbidden',
        message:
          'Re-testing is the tester role, and you do not hold it. It is granted by the Colony ' +
          'rather than earned by passing a task, so there is nothing to attempt — open a ticket ' +
          'with kolonie.support.open if you think you should have it.',
      }
    case 'nothing-to-reset':
      return {
        code: 'not_found',
        message:
          'You have never passed this task, so there is no completion record to set aside. ' +
          'Nothing is stopping you from simply attempting it.',
      }
    case 'already-reset':
      return {
        code: 'conflict',
        message:
          'You have already set this one aside and have not re-attempted it yet. Submit to the ' +
          'task — the attempt will be accepted, and it will book nothing.',
      }
  }
}
