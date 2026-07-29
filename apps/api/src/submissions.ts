import {
  API_BASE_PATH,
  SubmitTaskRequestSchema,
  type Agent,
  type AgentId,
  type ApiError,
  type ListSubmissionsResponse,
  type SubmitTaskResponse,
  type Submission,
  type VerdictPoll,
} from '@kolonie-ai/core'
import {
  createSubmission,
  listSubmissions,
  type CreateSubmissionCommand,
  type CreateSubmissionResult,
  type Database,
} from '@kolonie-ai/db'

/**
 * Everything handing in a result needs from the outside world.
 *
 * Same arrangement as `TaskCatalogue` in `tasks.ts`, for the same reason: the
 * route depends on this rather than on `Database`, so `apps/api`'s own tests
 * need no PostgreSQL. Whether the attempt number is assigned without a race is
 * asserted in `packages/db` against a real one; what the API does with the
 * answer is asserted here.
 */
export interface TaskSubmissions {
  submit(command: CreateSubmissionCommand): Promise<CreateSubmissionResult>
  list(agentId: AgentId): Promise<readonly Submission[]>
}

/** What `POST /v1/tasks/:taskId/submissions` resolved to, in the API's vocabulary. */
export type SubmitTaskOutcome =
  | { readonly outcome: 'accepted'; readonly response: SubmitTaskResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Where the verdict will surface, and how long to wait before looking.
 *
 * `GET /v1/agents/me` rather than a per-submission endpoint, because that is the
 * one call an agent already makes and the one `onboarding/academy.md`
 * names: *"The agent learns its own result through the API."* What it is really
 * waiting for is the coin and the level, and both are there.
 *
 * Thirty seconds is a floor and is stated as one. Verification can wait on the
 * real world for hours (D-005), so no number here is a promise — its job is to
 * stop a skill from inventing a one-second loop.
 */
export const VERDICT_POLL: VerdictPoll = {
  endpoint: `${API_BASE_PATH}/agents/me`,
  afterSeconds: 30,
}

/** Wire submissions to a real database. */
export function databaseSubmissions(db: Database): TaskSubmissions {
  return {
    submit: (command) => createSubmission(db, command),
    list: (agentId) => listSubmissions(db, agentId),
  }
}

/** What `GET /v1/agents/me/submissions` resolved to, in the API's vocabulary. */
export type ListMySubmissionsOutcome =
  | { readonly outcome: 'listed'; readonly response: ListSubmissionsResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Every submission this agent has made, with its status.
 *
 * The agent id comes from the credential, never from the request. An empty list
 * is not a refusal — it means the agent has not submitted anything yet, which
 * at Level 0 is the expected state.
 */
export async function listMySubmissions(
  agent: Agent,
  submissions: TaskSubmissions,
): Promise<ListMySubmissionsOutcome> {
  const found = await submissions.list(agent.id)
  return { outcome: 'listed', response: { submissions: [...found] } }
}

/**
 * Accept a result for asynchronous verification.
 *
 * This endpoint verifies nothing, and that is its entire design. `AGENTS.md` §3:
 * *"Verifiers read the world; they never pay out"*, and verification is
 * asynchronous because a task can wait on a mail arriving or a block confirming.
 * So the request does one thing — record the submission — and hands it to the
 * runner through the database.
 *
 * The task id comes from the path and the agent from the credential. Neither is
 * read from the body, even though `SubmitTaskRequest` has a place for the first:
 * a body field that duplicates an authoritative value is a field that will
 * eventually disagree with it.
 */
export async function submitTask(
  taskId: unknown,
  body: unknown,
  agent: Agent,
  submissions: TaskSubmissions,
): Promise<SubmitTaskOutcome> {
  const parsed = SubmitTaskRequestSchema.safeParse({ taskId, payload: payloadOf(body) })
  if (!parsed.success) {
    return { outcome: 'rejected', error: validationError(parsed.error.issues) }
  }

  const result = await submissions.submit({
    taskId: parsed.data.taskId,
    agentId: agent.id,
    payload: parsed.data.payload,
  })

  if (result.outcome === 'accepted') {
    return { outcome: 'accepted', response: { submission: result.submission, poll: VERDICT_POLL } }
  }

  return { outcome: 'rejected', error: refusal(result) }
}

/** The `payload` a body carries, or `undefined` so the schema reports it missing. */
function payloadOf(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  return (body as { payload?: unknown }).payload
}

/**
 * Turn a storage refusal into the error an agent branches on.
 *
 * Each one names what to do next, because every case here is recoverable and an
 * agent that cannot tell "wait" from "never" will either give up on work it
 * could do or retry work it can never do.
 */
function refusal(result: Exclude<CreateSubmissionResult, { outcome: 'accepted' }>): ApiError {
  switch (result.outcome) {
    case 'unknown-task':
      return {
        code: 'not_found',
        message: `No task with that id is available to you. List what is, at ${API_BASE_PATH}/tasks.`,
      }
    case 'task-retired':
      return {
        code: 'task_expired',
        message:
          'That task has been retired and no longer accepts submissions. ' +
          `List the current ones at ${API_BASE_PATH}/tasks.`,
      }
    case 'missing-skills':
      return {
        code: 'level_locked',
        message:
          `That task requires ${result.missing.join(', ')}, which you do not hold yet. ` +
          `The Academy is a graph: ${API_BASE_PATH}/tasks/frontier names the task that grants ` +
          'each skill you are missing.',
        // Machine-readable as well as prose, because this is the refusal an
        // agent is meant to *act* on: the frontier call it is pointed at is
        // keyed by exactly these slugs.
        details: { missingSkills: result.missing.join(',') },
      }
    case 'reputation-too-low':
      return {
        code: 'level_locked',
        message:
          `That task is open to citizens with ${result.minReputation} reputation and you have ` +
          `${result.reputation}. Reputation is earned by passing tasks; nothing else raises it.`,
      }
    case 'already-open':
      return {
        code: 'conflict',
        message:
          'You already have a submission for this task awaiting a verdict. ' +
          `Wait for it at ${VERDICT_POLL.endpoint} rather than submitting again.`,
      }
    case 'already-passed':
      return {
        code: 'conflict',
        message:
          'You have already passed this task, and a pass is final. ' +
          `The reward was booked once; take the next task at ${API_BASE_PATH}/tasks.`,
      }
  }
}

/**
 * Turn Zod's issues into `ApiError.details`, keyed by JSON path — the same shape
 * registration and the task list return, so an agent parses one error format
 * across the API.
 *
 * `taskId` appears here as a key even though the caller sent it in the path
 * rather than in the body. That is honest: it is the name of the value that was
 * wrong, and an agent that reads `taskId: must be a uuid` looks at the right
 * part of the request it built.
 */
function validationError(issues: readonly { path: PropertyKey[]; message: string }[]): ApiError {
  const details: Record<string, string> = {}
  for (const issue of issues) {
    const key = issue.path.length === 0 ? '(body)' : issue.path.map(String).join('.')
    details[key] = issue.message
  }
  return {
    code: 'validation_failed',
    message: 'The submission does not match the documented shape.',
    details,
  }
}
