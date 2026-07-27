import type { TaskType, Verifier } from '@kolonie-ai/core'
import { ApiCallVerifier } from './api-call.js'

export { ApiCallVerifier } from './api-call.js'

/**
 * Every verifier the runner knows about, keyed by the task type it handles.
 *
 * A task type with no entry here is not a crash — the runner leaves such a
 * submission `pending` and logs it. A verifier that is deployed late must not
 * fail submissions that were correct.
 */
export const VERIFIERS: ReadonlyMap<TaskType, Verifier> = new Map(
  [new ApiCallVerifier()].map((verifier) => [verifier.taskType, verifier]),
)

/** The verifier for a task type, or `undefined` if none is deployed yet. */
export function verifierFor(taskType: TaskType): Verifier | undefined {
  return VERIFIERS.get(taskType)
}
