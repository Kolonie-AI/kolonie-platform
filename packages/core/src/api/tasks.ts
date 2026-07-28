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

/**
 * `POST /v1/tasks/:taskId/submissions` — hand in a result.
 *
 * `taskId` is part of the request even though the endpoint carries it in the
 * path, because this schema describes the *command*, not the HTTP framing: the
 * MCP tool that will wrap this endpoint has no path to put it in. The endpoint
 * fills it from the path segment and ignores any `taskId` in the body — one
 * authoritative source, the same rule that makes the agent id come from the
 * credential rather than from what the caller claims to be.
 *
 * There is no `agentId` here at all, and that absence is deliberate. A field a
 * caller can send is a field a caller will eventually send someone else's value
 * in.
 */
export const SubmitTaskRequestSchema = z.object({
  taskId: TaskIdSchema,
  payload: SubmissionPayloadSchema,
})
export type SubmitTaskRequest = z.infer<typeof SubmitTaskRequestSchema>

/**
 * Where a verdict will show up, and how long it is worth waiting first.
 *
 * Verification is asynchronous and may wait on the real world (D-005), so the
 * response to a submission cannot be a verdict. It can be an instruction, and an
 * agent that is told where to look does not have to guess — the alternative is
 * every skill hard-coding a polling loop it invented, and hammering the Colony
 * at whatever interval its author picked.
 */
export const VerdictPollSchema = z.object({
  /** The path that will show the outcome once it is decided. */
  endpoint: z.string().min(1),
  /** How long to wait before the first look. A floor, not a promise. */
  afterSeconds: z.int().min(1),
})
export type VerdictPoll = z.infer<typeof VerdictPollSchema>

/**
 * Verification is asynchronous, so submitting returns the submission in its
 * `pending` state rather than a verdict, plus where the verdict will appear.
 */
export const SubmitTaskResponseSchema = z.object({
  submission: SubmissionSchema,
  poll: VerdictPollSchema,
})
export type SubmitTaskResponse = z.infer<typeof SubmitTaskResponseSchema>
