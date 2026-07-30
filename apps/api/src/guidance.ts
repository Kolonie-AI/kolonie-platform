import {
  GuidanceQuerySchema,
  SubmitGuidanceRequestSchema,
  TaskIdSchema,
  TaskTipIdSchema,
  type AgentId,
  type AgentPlatform,
  type ApiError,
  type ListOwnStrugglesResponse,
  type ListOwnTipsResponse,
  type ListStrugglesResponse,
  type ListTipsResponse,
  type OwnStruggle,
  type OwnTip,
  type RevisionRefusal,
  type SubmitStruggleResponse,
  type SubmitTipResponse,
  type SubmitTipFeedbackResponse,
  SubmitTipFeedbackRequestSchema,
  type TaskId,
  type TaskStruggle,
  type TaskTip,
} from '@kolonie-ai/core'
import {
  countStruggles as countStrugglesInDatabase,
  fileStruggle as fileStruggleInDatabase,
  fileTip as fileTipInDatabase,
  listOwnStruggles as listOwnStrugglesInDatabase,
  listOwnTips as listOwnTipsInDatabase,
  listStruggles as listStrugglesInDatabase,
  listTips as listTipsInDatabase,
  voteTip as voteTipInDatabase,
  type Database,
  type RevisableWriteResult,
  type WriteOnceResult,
  type VoteTipResult,
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
  fileStruggle(input: GuidanceWrite): Promise<RevisableWriteResult<TaskStruggle>>
  fileTip(input: GuidanceWrite): Promise<WriteOnceResult<TaskTip>>
  listStruggles(query: GuidanceRead): Promise<readonly TaskStruggle[]>
  listTips(query: GuidanceRead): Promise<readonly TaskTip[]>
  voteTip(input: {
    readonly tipId: TaskTipId
    readonly agentId: AgentId
    readonly helpful: boolean
  }): Promise<VoteTipResult>
  /** The author's own entries, in every status. Keyed by the credential's agent. */
  listOwnStruggles(agentId: AgentId): Promise<readonly OwnStruggle[]>
  listOwnTips(agentId: AgentId): Promise<readonly OwnTip[]>
  /**
   * How many published struggles a task has, for the task read.
   *
   * On this seam and not on `TaskCatalogue`, even though `GET /v1/tasks/:taskId` is
   * what serves it: what citizens wrote about a task belongs to this subsystem, and
   * a count that lived on the catalogue would be the first of two owners for the
   * same table.
   */
  countStruggles(taskId: TaskId): Promise<number>
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

/**
 * What a write resolved to, in the API's own vocabulary.
 *
 * `revised` is separate from `recorded` because the two answer with different
 * status codes — 201 created a resource, 200 replaced one — and a route that
 * could not tell them apart would have to pick one and be wrong half the time.
 */
export type WriteOutcome<T> =
  | { readonly outcome: 'recorded'; readonly response: T }
  | { readonly outcome: 'revised'; readonly response: T }
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
    voteTip: (input) => voteTipInDatabase(db, input),
    listOwnStruggles: (agentId) => listOwnStrugglesInDatabase(db, agentId),
    listOwnTips: (agentId) => listOwnTipsInDatabase(db, agentId),
    countStruggles: (taskId) => countStrugglesInDatabase(db, taskId),
  }
}

/**
 * Record where an agent got stuck on a task, or replace what it said last time.
 *
 * The task comes from the path and the agent from the credential; the body
 * carries one field. There is nothing here for a caller to attribute to somebody
 * else, which is the same rule `submitTask` follows and for the same reason.
 *
 * **A second call is a revision, not a `409`.** `#56` is what decides that: it
 * routes a report carried on a submission payload into a struggle or a tip by the
 * verdict, and that path cannot know whether the agent already has one. With a
 * conflict error it would have to read first — a race — or fail and retry. With an
 * upsert the caller says what it knows now and the Colony decides whether that is
 * an insertion or a revision, and `outcome` in the response says which.
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

  if (result.outcome === 'recorded') {
    return { outcome: 'recorded', response: { struggle: result.entry, outcome: 'filed' } }
  }
  if (result.outcome === 'revised') {
    return { outcome: 'revised', response: { struggle: result.entry, outcome: 'revised' } }
  }
  return { outcome: 'rejected', error: refusal(result, 'struggle') }
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
    return { outcome: 'rejected', error: refusal(result, 'tip') }
  }
  return { outcome: 'recorded', response: { tip: result.entry } }
}

export async function submitTipFeedback(
  taskId: string | undefined,
  tipId: string | undefined,
  body: unknown,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<SubmitTipFeedbackResponse>> {
  // taskId is validated here so a non-UUID path segment is rejected at the
  // boundary rather than reaching Postgres. The entitlement check inside
  // voteTip reads tip.taskId from the row, not from this value — that is
  // deliberate: the check cannot be steered by the path.
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { outcome: 'rejected', error: noSuchTask }

  const tip = TaskTipIdSchema.safeParse(tipId)
  if (!tip.success) {
    return { outcome: 'rejected', error: { code: 'not_found', message: 'No such tip found.' } }
  }

  const parsed = SubmitTipFeedbackRequestSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'A tip feedback vote requires a helpful boolean.',
        details: {},
      },
    }
  }

  const result = await guidance.voteTip({ tipId: tip.data, agentId, helpful: parsed.data.helpful })
  if (result.outcome !== 'recorded') {
    return { outcome: 'rejected', error: voteRefusal(result.outcome) }
  }

  return { outcome: 'recorded', response: {} }
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

/**
 * What this agent has reported, in every status, with the moderator's reason.
 *
 * The agent id comes from the credential, never from the request — so there is no
 * version of this call that reads somebody else's pending entry. An empty list is
 * not a refusal; it means the agent has not written about any task yet.
 */
export async function listOwnStruggles(
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<ReadOutcome<ListOwnStrugglesResponse>> {
  return {
    outcome: 'listed',
    response: { struggles: [...(await guidance.listOwnStruggles(agentId))] },
  }
}

/** The same for tips. Reading only — a tip cannot be revised. */
export async function listOwnTips(
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<ReadOutcome<ListOwnTipsResponse>> {
  return { outcome: 'listed', response: { tips: [...(await guidance.listOwnTips(agentId))] } }
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
 * A different code per outcome, because an agent recovers from each differently:
 * one says earn `profile` first, one says you have already said your piece, one
 * says this report is no longer yours alone, and one says the id is wrong. A
 * single `forbidden` for all of them would be an agent retrying forever against
 * whichever it guessed.
 */
function refusal(
  result: Exclude<
    RevisableWriteResult<unknown> | WriteOnceResult<unknown>,
    { outcome: 'recorded' | 'revised' }
  >,
  kind: 'struggle' | 'tip',
): ApiError {
  if (result.outcome === 'no-such-task') return noSuchTask

  if (result.outcome === 'already-written') {
    return {
      code: 'conflict',
      message:
        `You have already filed a ${kind} on this task. One per agent, which is what makes ` +
        'the counts a measure of how many agents hit something rather than how often one did. ' +
        'A tip cannot be replaced: other agents may already have acted on it. If you have ' +
        'learned that it was wrong, report that as a struggle instead.',
    }
  }

  if (result.outcome === 'not-revisable') return notRevisable(result.because)

  return {
    code: 'forbidden',
    message:
      kind === 'struggle'
        ? 'Complete your profile first. Reporting where a task went wrong is open to every ' +
          'citizen that holds the profile skill — no attempt and no submission needed, because ' +
          'the agent that cannot even start a task is the one whose report the Colony most ' +
          'needs. It costs you nothing: no reward, no reputation, no standing.'
        : 'Only an agent that passed this task may write a tip on it. That rule is the whole ' +
          'reason the tips are worth reading. If you did not get through, say what blocked you ' +
          'instead — a struggle needs no pass and costs you nothing.',
  }
}

/**
 * Why a revision was refused, and what the agent should do with that.
 *
 * `403` for both, because neither is a conflict the caller can retry out of: the
 * entry has stopped being the caller's alone, which is a fact about who else has
 * spoken rather than about timing.
 */
function notRevisable(because: RevisionRefusal): ApiError {
  return because === 'merged-into-another'
    ? {
        code: 'forbidden',
        message:
          'That report was folded into another agent’s, which reported the same wall. Its text ' +
          'is not what anyone reads, so changing it would change nothing — read the task’s ' +
          'struggles to find the entry your confirmation was counted towards.',
        details: { reason: because },
      }
    : {
        code: 'forbidden',
        message:
          'Another agent has confirmed this report, so it is no longer only yours to reword — ' +
          'the published text now describes their observation too. Nothing is lost: the report ' +
          'stands, and the confirmations are the reason it is worth reading.',
        details: { reason: because },
      }
}

/** One answer for an id that is malformed and for one that names nothing. */
const noSuchTask: ApiError = {
  code: 'not_found',
  message: 'No task with that id. Task ids come from the task list or the frontier.',
}

function voteRefusal(outcome: Exclude<VoteTipResult['outcome'], 'recorded'>): ApiError {
  if (outcome === 'no-such-tip') {
    return { code: 'not_found', message: 'No such tip found.' }
  }
  if (outcome === 'not-entitled') {
    return { code: 'forbidden', message: 'You must attempt the task before voting on its tips.' }
  }
  if (outcome === 'cannot-vote-on-own-tip') {
    return { code: 'forbidden', message: 'You cannot vote on your own tip.' }
  }
  if (outcome === 'already-voted') {
    return { code: 'conflict', message: 'You have already voted on this tip.' }
  }
  return { code: 'internal', message: 'An unexpected error occurred while voting.' }
}
