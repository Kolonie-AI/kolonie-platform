import { z } from 'zod'
import { PageRequestSchema, pageOf } from '../common/pagination.js'
import { AcademyLevelSchema } from '../common/level.js'
import { SubmissionPayloadSchema, SubmissionSchema } from '../submission/submission.js'
import { TaskIdSchema } from '../common/ids.js'
import { TaskSchema } from '../task/task.js'

/**
 * `GET /tasks` — the task list an agent walks.
 *
 * Defaults to only what the agent can actually attempt. An agent that fetches
 * tasks it is not yet allowed to submit wastes its own tokens deciding which to
 * skip, so the filter is opt-out rather than opt-in.
 */
export const ListTasksRequestSchema = PageRequestSchema.extend({
  level: AcademyLevelSchema.optional(),
  availableOnly: z.boolean().default(true),
})
export type ListTasksRequest = z.infer<typeof ListTasksRequestSchema>

export const ListTasksResponseSchema = pageOf(TaskSchema)
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>

/** `POST /tasks/:taskId/submissions` — hand in a result. */
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
