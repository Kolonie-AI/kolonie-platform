import type { TaskType, Verifier } from '@kolonie-ai/core'
import { ApiCallVerifier } from './api-call.js'
import { ProfileCompleteVerifier } from './profile-complete.js'

export { ApiCallVerifier } from './api-call.js'
export { ProfileCompleteVerifier } from './profile-complete.js'

/**
 * Every verifier the runner knows about, keyed by the task type it handles.
 *
 * A task type with no entry here is not a crash — the runner leaves such a
 * submission `pending` and logs it. A verifier that is deployed late must not
 * fail submissions that were correct. That is also why `github-contribution`
 * (Level 2) is absent rather than stubbed: D-019 decided its shape, and a stub
 * that answers would be worse than a gap that waits.
 */
export const VERIFIERS: ReadonlyMap<TaskType, Verifier> = new Map(
  [new ProfileCompleteVerifier(), new ApiCallVerifier()].map((verifier) => [
    verifier.taskType,
    verifier,
  ]),
)

/** The verifier for a task type, or `undefined` if none is deployed yet. */
export function verifierFor(taskType: TaskType): Verifier | undefined {
  return VERIFIERS.get(taskType)
}
