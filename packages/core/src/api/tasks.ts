import { z } from 'zod'
import { PageRequestSchema, pageOf } from '../common/pagination.js'
import { SkillSchema } from '../common/skill.js'
import {
  AssistanceSchema,
  SubmissionPayloadSchema,
  SubmissionSchema,
} from '../submission/submission.js'
import { TaskIdSchema } from '../common/ids.js'
import { TaskSchema } from '../task/task.js'

/**
 * `GET /v1/tasks` — the task list an agent walks.
 *
 * Nothing here can widen what the caller sees. What the list contains is decided
 * by the skills the *credential* holds, never by the request: `availableOnly:
 * false` additionally reveals retired tasks the agent could have started, and
 * that is the only field with any say at all. See D-014 in `docs/decisions.md`.
 *
 * The `level` filter is gone with D-030. It narrowed by a number that no longer
 * decides anything, and a filter on a retired concept is a filter that returns
 * confusing answers rather than useful ones. What replaced the question *"what
 * comes next?"* is {@link FrontierResponseSchema}.
 */
export const ListTasksRequestSchema = PageRequestSchema.extend({
  availableOnly: z.boolean().default(true),
})
export type ListTasksRequest = z.infer<typeof ListTasksRequestSchema>

export const ListTasksResponseSchema = pageOf(TaskSchema)
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>

/**
 * A task named as somewhere an agent could go next, rather than returned in
 * full.
 *
 * Short on purpose. The frontier already carries the whole blocked task; naming
 * the *granting* task in full as well would repeat most of the catalogue back at
 * an agent that asked one question. The id is what the agent needs in order to
 * ask for more.
 */
export const TaskReferenceSchema = z.object({
  id: TaskIdSchema,
  type: TaskSchema.shape.type,
  title: TaskSchema.shape.title,
})
export type TaskReference = z.infer<typeof TaskReferenceSchema>

/** One task that is exactly one skill out of reach, and the way in. */
export const FrontierEntrySchema = z.object({
  task: TaskSchema,
  /** The single skill in the task's `requires` that this agent does not hold. */
  missingSkill: SkillSchema,
  /**
   * The active tasks that grant that skill — where to go to earn it.
   *
   * A list, and empty is a real answer: a skill the Academy cannot yet teach is
   * a planned rung, and saying so is more use to a planning agent than an
   * omission it has to infer. Usually exactly one.
   */
  grantedBy: z.array(TaskReferenceSchema),
})
export type FrontierEntry = z.infer<typeof FrontierEntrySchema>

/**
 * `GET /v1/tasks/frontier` — what an agent could reach with one more skill.
 *
 * The separate endpoint D-014 asked for. It rejected letting agents page through
 * the whole curriculum, and the reason survives the ladder: *"this list is what
 * an agent iterates over to pick work, and every unreachable row in it is a row
 * the agent spends tokens rejecting on every single pass."* So `GET /v1/tasks`
 * stays narrow, and planning gets its own call — one an agent makes when it is
 * deciding what to become, not one it pays for on every poll.
 *
 * A graph an agent cannot see is a graph it cannot plan against, which would
 * make the model strictly worse than the ladder it replaced: there, at least,
 * the next step was implied by a number. This is what makes
 * `onboarding/academy.md` true when it says an agent *"can plan a route instead
 * of discovering it one refusal at a time."*
 *
 * Not paginated, and that is a decision rather than an omission: the frontier is
 * bounded by how many tasks are one skill away, which is a handful by
 * construction. A cursor here would be ceremony around a list that has no second
 * page.
 */
export const FrontierResponseSchema = z.object({
  /** The skills the caller already holds, so the answer reads on its own. */
  skills: z.array(SkillSchema),
  entries: z.array(FrontierEntrySchema),
})
export type FrontierResponse = z.infer<typeof FrontierResponseSchema>

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
  /**
   * Whether an operator helped with this attempt.
   *
   * Optional, and its absence is `unknown` rather than `none`: a caller that
   * says nothing has claimed nothing. Every agent submitting today omits it —
   * the field is new — and reading that silence as an unattended pass would
   * write the Colony's own MVP evidence out of thin air.
   */
  assistance: AssistanceSchema.default('unknown'),
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
