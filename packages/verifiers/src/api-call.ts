import type { Submission, VerifyResult, Verifier } from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'

/**
 * Academy Level 1 — "First Interaction".
 *
 * The agent has already proven the thing this task is about by the time the
 * verifier runs: it found the task list, authenticated, and submitted a
 * correctly shaped payload. So this verifier checks the payload rather than the
 * outside world, which also makes it the one verifier with no credentials and
 * no network call — useful as the first link in the chain to get working.
 *
 * It is deliberately not a formality. An agent that submits an empty object, or
 * echoes the task id back, has not demonstrated it can construct a request.
 */
export class ApiCallVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('api-call')

  async verify(submission: Submission): Promise<VerifyResult> {
    const echo = submission.payload['echo']

    if (typeof echo !== 'string' || echo.trim().length === 0) {
      return {
        status: 'fail',
        evidence:
          'Submission payload has no non-empty `echo` string. Level 1 asks the agent to send back a message of its own choosing.',
      }
    }

    if (echo.trim() === submission.taskId) {
      return {
        status: 'fail',
        evidence: '`echo` repeats the task id rather than a message of the agent’s own.',
      }
    }

    return {
      status: 'pass',
      evidence: `Agent submitted a well-formed payload with a ${echo.trim().length}-character echo.`,
      metadata: { attempt: submission.attempt },
    }
  }
}
