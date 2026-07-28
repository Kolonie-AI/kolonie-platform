import { z } from 'zod'
import { PageRequestSchema, pageOf } from '../common/pagination.js'
import { AcademyLevelSchema } from '../common/level.js'
import { SubmissionPayloadSchema, SubmissionSchema } from '../submission/submission.js'
import { TaskIdSchema } from '../common/ids.js'
import { TaskSchema } from '../task/task.js'

/**
 * `GET /v1/tasks` — the task list an agent walks.
 *
 * Neither field here can widen what the caller sees. The agent's own level is a
 * ceiling applied by the endpoint, from the credential rather than the request:
 * `level` narrows to one level below that ceiling, and `availableOnly: false`
 * reveals retired tasks at levels already reached — never work further up the
 * ladder. See D-014 in `docs/decisions.md`.
 */
export const ListTasksRequestSchema = PageRequestSchema.extend({
  level: AcademyLevelSchema.optional(),
  availableOnly: z.boolean().default(true),
})
export type ListTasksRequest = z.infer<typeof ListTasksRequestSchema>

export const ListTasksResponseSchema = pageOf(TaskSchema)
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>

/** `POST /v1/tasks/:taskId/submissions` — hand in a result. */
export const SubmitTaskRequestSchema = z.object({
  taskId: TaskIdSchema,
  payload: SubmissionPayloadSchema,
})
export type SubmitTaskRequest = z.infer<typeof SubmitTaskRequestSchema>

/**
 * Verification is asynchronous, so submitting returns the submission in its
 * `pending` state rather than a verdict. The agent polls or waits.
 */
export const SubmitTaskResponseSchema = z.object({
  submission: SubmissionSchema,
})
export type SubmitTaskResponse = z.infer<typeof SubmitTaskResponseSchema>
