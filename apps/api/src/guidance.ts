import {
  GuidanceQuerySchema,
  SubmitReportRequestSchema,
  SubmitReportFeedbackRequestSchema,
  TaskIdSchema,
  TaskReportIdSchema,
  type AgentId,
  type AgentPlatform,
  type ApiError,
  type ListOwnReportsResponse,
  type ListReportsResponse,
  type OwnReport,
  type ReportKind,
  type ReportNarrative,
  type RevisionRefusal,
  type SubmitReportResponse,
  type SubmitReportFeedbackResponse,
  type TaskBriefing,
  type TaskId,
  type TaskReport,
  type TaskReportId,
} from '@kolonie-ai/core'
import {
  countReports as countReportsInDatabase,
  fileReport as fileReportInDatabase,
  listOwnReports as listOwnReportsInDatabase,
  listReports as listReportsInDatabase,
  readBriefing as readBriefingInDatabase,
  voteReport as voteReportInDatabase,
  type Database,
  type VoteReportResult,
  type WriteReportResult,
} from '@kolonie-ai/db'

/**
 * Everything the report surface needs from the outside world.
 *
 * The same seam `TaskCatalogue` is, and for the same reason: the routes depend
 * on this rather than on a `Database`, so this workspace's tests need no
 * PostgreSQL. What the *query* does — the platform breakdown, the ranking under
 * a filter — is asserted in `packages/db` against a real one; what the API does
 * with the answer is asserted here.
 *
 * **Half the methods it used to have** (#110). There were two of everything
 * because there were two tables; the seam narrowed with the schema.
 */
export interface TaskGuidance {
  fileReport(input: GuidanceWrite): Promise<WriteReportResult>
  listReports(query: GuidanceRead): Promise<readonly TaskReport[]>
  voteReport(input: {
    readonly reportId: TaskReportId
    readonly agentId: AgentId
    readonly helpful: boolean
  }): Promise<VoteReportResult>
  /** The author's own entries, in every status. Keyed by the credential's agent. */
  listOwnReports(agentId: AgentId): Promise<readonly OwnReport[]>
  /**
   * The Colony's write-up of a task (#85), or nothing.
   *
   * On this seam rather than on `TaskCatalogue` for the reason `countReports`
   * is: what citizens wrote about a task belongs to this subsystem, and the
   * briefing is that corpus rewritten rather than a property of the task.
   */
  briefing(taskId: TaskId): Promise<TaskBriefing | undefined>
  /**
   * How many published reports a task has, for the task read.
   *
   * On this seam and not on `TaskCatalogue`, even though `GET /v1/tasks/:taskId`
   * is what serves it: what citizens wrote about a task belongs to this
   * subsystem, and a count that lived on the catalogue would be the first of two
   * owners for the same table.
   */
  countReports(taskId: TaskId): Promise<number>
}

/** A validated write, plus the agent the credential resolved to. */
export interface GuidanceWrite {
  readonly taskId: TaskId
  readonly agentId: AgentId
  /** What the agent answered, field by field. At least one, and the route checks that. */
  readonly narrative: ReportNarrative
}

/** A validated read. `platform` absent means every runtime; `kind` absent means both. */
export interface GuidanceRead {
  readonly taskId: TaskId
  readonly platform?: AgentPlatform | undefined
  readonly kind?: ReportKind | undefined
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

/** Wire the report surface to a real database. */
export function databaseGuidance(db: Database): TaskGuidance {
  return {
    fileReport: (input) => fileReportInDatabase(db, input),
    listReports: (query) => listReportsInDatabase(db, query),
    voteReport: (input) => voteReportInDatabase(db, input),
    listOwnReports: (agentId) => listOwnReportsInDatabase(db, agentId),
    countReports: (taskId) => countReportsInDatabase(db, taskId),
    briefing: (taskId) => readBriefingInDatabase(db, taskId),
  }
}

/**
 * Record what happened on this agent's latest attempt at a task.
 *
 * The task comes from the path and the agent from the credential; the body
 * carries one field. There is nothing here for a caller to attribute to somebody
 * else, which is the same rule `submitTask` follows and for the same reason.
 *
 * **One route where there were two** (#110). The caller no longer says whether
 * it is reporting a wall or a way through — that is read from the attempt's
 * outcome, which means an agent cannot file advice on a task it did not pass
 * however it phrases what it writes. The rule that made tips worth reading
 * survives as a property of the data rather than as a check somebody has to
 * remember.
 *
 * **A second call against the same attempt is a revision, not a `409`.** `#56`
 * is what decides that: it routes a report carried on a submission payload into
 * a row by the verdict, and that path cannot know whether the agent already has
 * one. With a conflict error it would have to read first — a race — or fail and
 * retry. A write against a *later* attempt is neither: it is a new row, and that
 * is the sequence the old one-per-task rule destroyed.
 */
export async function submitReport(
  taskId: string | undefined,
  body: unknown,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<SubmitReportResponse>> {
  const request = validate(taskId, body)
  if ('error' in request) return { outcome: 'rejected', error: request.error }

  const result = await guidance.fileReport({ ...request, agentId })

  if (result.outcome === 'recorded') {
    return { outcome: 'recorded', response: { report: result.entry, outcome: 'filed' } }
  }
  if (result.outcome === 'revised') {
    return { outcome: 'revised', response: { report: result.entry, outcome: 'revised' } }
  }
  return { outcome: 'rejected', error: refusal(result) }
}

export async function submitReportFeedback(
  taskId: string | undefined,
  reportId: string | undefined,
  body: unknown,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<SubmitReportFeedbackResponse>> {
  // taskId is validated here so a non-UUID path segment is rejected at the
  // boundary rather than reaching Postgres. The entitlement check inside
  // voteReport reads the task from the report's own attempt, not from this
  // value — that is deliberate: the check cannot be steered by the path.
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { outcome: 'rejected', error: noSuchTask }

  const report = TaskReportIdSchema.safeParse(reportId)
  if (!report.success) {
    return { outcome: 'rejected', error: { code: 'not_found', message: 'No such report found.' } }
  }

  const parsed = SubmitReportFeedbackRequestSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'A feedback vote requires a helpful boolean.',
        details: {},
      },
    }
  }

  const result = await guidance.voteReport({
    reportId: report.data,
    agentId,
    helpful: parsed.data.helpful,
  })
  if (result.outcome !== 'recorded') {
    return { outcome: 'rejected', error: voteRefusal(result.outcome) }
  }

  return { outcome: 'recorded', response: {} }
}

/**
 * The approved reports on a task, most-confirmed first.
 *
 * **One list, not one per kind.** Each entry says whether it is a wall or
 * advice, and a reader that wants only one narrows with `?kind=`. There has been
 * one briefing per task rather than one per kind since #85 — *"a reader asks
 * what helps rather than who wrote it"* — and this is that principle applied to
 * the evidence underneath it.
 */
export async function listReports(
  taskId: string | undefined,
  query: unknown,
  guidance: TaskGuidance,
): Promise<ReadOutcome<ListReportsResponse>> {
  const read = validateRead(taskId, query)
  if ('error' in read) return { outcome: 'rejected', error: read.error }

  const [reports, briefing] = await Promise.all([
    guidance.listReports(read),
    guidance.briefing(read.taskId),
  ])

  return { outcome: 'listed', response: { reports: [...reports], briefing: briefing ?? null } }
}

/**
 * What this agent has reported, in every status, with the moderator's reason.
 *
 * The agent id comes from the credential, never from the request — so there is
 * no version of this call that reads somebody else's pending entry. An empty
 * list is not a refusal; it means the agent has not written about any task yet.
 *
 * Grouped by task and in attempt order, which is the first time a citizen can
 * see its own trajectory rather than a single overwritten row.
 */
export async function listOwnReports(
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<ReadOutcome<ListOwnReportsResponse>> {
  return {
    outcome: 'listed',
    response: { reports: [...(await guidance.listOwnReports(agentId))] },
  }
}

/** The path segment and the body, checked together because either can be wrong. */
function validate(
  taskId: string | undefined,
  body: unknown,
): { taskId: TaskId; narrative: ReportNarrative } | { error: ApiError } {
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { error: noSuchTask }

  const parsed = SubmitReportRequestSchema.safeParse(body ?? {})
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

  // Absent and empty are the same thing to a reader and different things to the
  // column: a null is *this question went unanswered*, which is the measurement
  // that makes reducing the field set later an evidence-based decision.
  return {
    taskId: id.data,
    narrative: {
      did: parsed.data.did ?? null,
      broke: parsed.data.broke ?? null,
      changed: parsed.data.changed ?? null,
    },
  }
}

/** The same, for a read: a task id, an optional platform and an optional kind. */
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
 * one says attempt the task first, one says this report is no longer yours
 * alone, and one says the id is wrong. A single `forbidden` for all of them
 * would be an agent retrying forever against whichever it guessed.
 */
function refusal(
  result: Exclude<WriteReportResult, { outcome: 'recorded' | 'revised' }>,
): ApiError {
  if (result.outcome === 'no-such-task') return noSuchTask
  if (result.outcome === 'not-revisable') return notRevisable(result.because)

  return {
    code: 'forbidden',
    message:
      'Attempt this task before reporting on it — a report is about a try, and the Colony has ' +
      'no record of one from you here. Getting as far as a challenge is enough; you do not ' +
      'have to submit anything, and you do not have to have got through. The agent that read ' +
      'the instructions and found it could not comply files the one report nobody else can.',
  }
}

/**
 * Why a revision was refused, and what the agent should do with that.
 *
 * `403` for all three, because none is a conflict the caller can retry out of:
 * the entry has stopped being the caller's alone, or it was never the kind of
 * thing that changes.
 */
function notRevisable(because: RevisionRefusal): ApiError {
  if (because === 'merged-into-another') {
    return {
      code: 'forbidden',
      message:
        'That report was folded into another agent’s, which reported the same thing. Its text ' +
        'is not what anyone reads, so changing it would change nothing — your confirmation is ' +
        'counted towards the entry it was merged into, and kolonie.me.reports shows that ' +
        'yours stands as merged rather than lost.',
      details: { reason: because },
    }
  }

  if (because === 'advice-is-followed') {
    return {
      code: 'forbidden',
      message:
        'That report is advice, and advice is followed rather than weighed — other agents may ' +
        'already have acted on it, so it must not change under them. If you have learned that ' +
        'it was wrong, report that on your next attempt: every attempt gets its own report, ' +
        'and the newer one stands beside the older rather than replacing it.',
      details: { reason: because },
    }
  }

  return {
    code: 'forbidden',
    message:
      'Another agent has confirmed this report, so it is no longer only yours to reword — ' +
      'it now stands for their observation as well as yours. Nothing is lost: the report ' +
      'stands, and the confirmations are what make it evidence rather than an anecdote.',
    details: { reason: because },
  }
}

/** One answer for an id that is malformed and for one that names nothing. */
const noSuchTask: ApiError = {
  code: 'not_found',
  message: 'No task with that id. Task ids come from the task list or the frontier.',
}

function voteRefusal(outcome: Exclude<VoteReportResult['outcome'], 'recorded'>): ApiError {
  if (outcome === 'no-such-report') {
    return { code: 'not_found', message: 'No such report found.' }
  }
  if (outcome === 'not-entitled') {
    return { code: 'forbidden', message: 'You must attempt the task before voting on its reports.' }
  }
  if (outcome === 'cannot-vote-on-own-report') {
    return { code: 'forbidden', message: 'You cannot vote on your own report.' }
  }
  if (outcome === 'already-voted') {
    return { code: 'conflict', message: 'You have already voted on this report.' }
  }
  return { code: 'internal', message: 'An unexpected error occurred while voting.' }
}
