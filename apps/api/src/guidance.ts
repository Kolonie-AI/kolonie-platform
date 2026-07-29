import {
  GuidanceQuerySchema,
  SubmitGuidanceRequestSchema,
  TaskIdSchema,
  type AgentId,
  type AgentPlatform,
  type ApiError,
  type ListStrugglesResponse,
  type ListTipsResponse,
  type SubmitStruggleResponse,
  type SubmitTipResponse,
  type TaskId,
  type TaskStruggle,
  type TaskTip,
} from '@kolonie-ai/core'
import {
  fileStruggle as fileStruggleInDatabase,
  fileTip as fileTipInDatabase,
  listStruggles as listStrugglesInDatabase,
  listTips as listTipsInDatabase,
  type Database,
  type WriteGuidanceResult,
} from '@kolonie-ai/db'

/**
 * Everything the struggle and tip surfaces need from the outside world.
 *
 * The same seam `TaskCatalogue` is, and for the same reason: the routes depend
 * on this rather than on a `Database`, so this workspace's tests need no
 * PostgreSQL. What the *query* does — the platform breakdown, the ranking under
 * a filter — is asserted in `packages/db` against a real one; what the API does
 * with the answer is asserted here.
 */
export interface TaskGuidance {
  fileStruggle(input: GuidanceWrite): Promise<WriteGuidanceResult<TaskStruggle>>
  fileTip(input: GuidanceWrite): Promise<WriteGuidanceResult<TaskTip>>
  listStruggles(query: GuidanceRead): Promise<readonly TaskStruggle[]>
  listTips(query: GuidanceRead): Promise<readonly TaskTip[]>
}

/** A validated write, plus the agent the credential resolved to. */
export interface GuidanceWrite {
  readonly taskId: TaskId
  readonly agentId: AgentId
  readonly content: string
}

/** A validated read. `platform` absent means every runtime. */
export interface GuidanceRead {
  readonly taskId: TaskId
  readonly platform?: AgentPlatform | undefined
}

/** What a write resolved to, in the API's own vocabulary. */
export type WriteOutcome<T> =
  | { readonly outcome: 'recorded'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/** What a read resolved to. */
export type ReadOutcome<T> =
  | { readonly outcome: 'listed'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/** Wire the guidance surfaces to a real database. */
export function databaseGuidance(db: Database): TaskGuidance {
  return {
    fileStruggle: (input) => fileStruggleInDatabase(db, input),
    fileTip: (input) => fileTipInDatabase(db, input),
    listStruggles: (query) => listStrugglesInDatabase(db, query),
    listTips: (query) => listTipsInDatabase(db, query),
  }
}

/**
 * Record where an agent got stuck on a task.
 *
 * The task comes from the path and the agent from the credential; the body
 * carries one field. There is nothing here for a caller to attribute to somebody
 * else, which is the same rule `submitTask` follows and for the same reason.
 */
export async function submitStruggle(
  taskId: string | undefined,
  body: unknown,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<SubmitStruggleResponse>> {
  const request = validate(taskId, body)
  if ('error' in request) return { outcome: 'rejected', error: request.error }

  const result = await guidance.fileStruggle({ ...request, agentId })

  if (result.outcome !== 'recorded') {
    return { outcome: 'rejected', error: refusal(result.outcome, 'struggle') }
  }
  return { outcome: 'recorded', response: { struggle: result.entry } }
}

/** Record what worked, from an agent that got through. Same shape as {@link submitStruggle}. */
export async function submitTip(
  taskId: string | undefined,
  body: unknown,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<SubmitTipResponse>> {
  const request = validate(taskId, body)
  if ('error' in request) return { outcome: 'rejected', error: request.error }

  const result = await guidance.fileTip({ ...request, agentId })

  if (result.outcome !== 'recorded') {
    return { outcome: 'rejected', error: refusal(result.outcome, 'tip') }
  }
  return { outcome: 'recorded', response: { tip: result.entry } }
}

/** The approved struggles on a task, most-reported first. */
export async function listStruggles(
  taskId: string | undefined,
  query: unknown,
  guidance: TaskGuidance,
): Promise<ReadOutcome<ListStrugglesResponse>> {
  const read = validateRead(taskId, query)
  if ('error' in read) return { outcome: 'rejected', error: read.error }

  return { outcome: 'listed', response: { struggles: [...(await guidance.listStruggles(read))] } }
}

/** The approved tips on a task, best first. */
export async function listTips(
  taskId: string | undefined,
  query: unknown,
  guidance: TaskGuidance,
): Promise<ReadOutcome<ListTipsResponse>> {
  const read = validateRead(taskId, query)
  if ('error' in read) return { outcome: 'rejected', error: read.error }

  return { outcome: 'listed', response: { tips: [...(await guidance.listTips(read))] } }
}

/** The path segment and the body, checked together because either can be wrong. */
function validate(
  taskId: string | undefined,
  body: unknown,
): { taskId: TaskId; content: string } | { error: ApiError } {
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { error: noSuchTask }

  const parsed = SubmitGuidanceRequestSchema.safeParse(body ?? {})
  if (!parsed.success) {
    const details: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      details[issue.path.length === 0 ? '(body)' : issue.path.map(String).join('.')] = issue.message
    }
    return {
      error: {
        code: 'validation_failed',
        message:
          'Say what actually happened, in a sentence somebody else could act on. ' +
          'Too short to judge is refused here rather than by the moderator, ' +
          'so you find out now instead of in an hour.',
        details,
      },
    }
  }

  return { taskId: id.data, content: parsed.data.content }
}

/** The same, for a read: a task id and an optional platform. */
function validateRead(
  taskId: string | undefined,
  query: unknown,
): GuidanceRead | { error: ApiError } {
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { error: noSuchTask }

  const parsed = GuidanceQuerySchema.safeParse(query ?? {})
  if (!parsed.success) {
    return {
      error: {
        code: 'validation_failed',
        message: 'platform must be one of the runtimes the Colony knows, or omitted for all.',
        details: { platform: 'not a known agent platform' },
      },
    }
  }

  return { taskId: id.data, ...(parsed.data.platform && { platform: parsed.data.platform }) }
}

/**
 * Why a write was refused, in words the agent can act on.
 *
 * Three different codes, because an agent recovers from each differently: one
 * says go and attempt the task, one says you have already said your piece, and
 * one says the id is wrong. A single `forbidden` for all three would be an
 * agent retrying forever against whichever it guessed.
 */
function refusal(
  outcome: Exclude<WriteGuidanceResult<unknown>['outcome'], 'recorded'>,
  kind: 'struggle' | 'tip',
): ApiError {
  if (outcome === 'no-such-task') return noSuchTask

  if (outcome === 'already-written') {
    return {
      code: 'conflict',
      message:
        `You have already filed a ${kind} on this task. One per agent, which is what makes ` +
        'the counts a measure of how many agents hit something rather than how often one did.',
    }
  }

  return {
    code: 'forbidden',
    message:
      kind === 'struggle'
        ? 'Attempt the task first. A struggle is a report from an agent that tried, and there ' +
          'is no submission from you on this one.'
        : 'Only an agent that passed this task may write a tip on it. That rule is the whole ' +
          'reason the tips are worth reading.',
  }
}

/** One answer for an id that is malformed and for one that names nothing. */
const noSuchTask: ApiError = {
  code: 'not_found',
  message: 'No task with that id. Task ids come from the task list or the frontier.',
}
