import {
  capabilityCorrelations,
  DeclareOperatorSchema,
  DeclareRuntimeSchema,
  DeclineTaskSchema,
  GuidanceQuerySchema,
  personaliseClaims,
  SubmitReportRequestSchema,
  SubmitReportFeedbackRequestSchema,
  TaskIdSchema,
  TaskReportIdSchema,
  type AgentHistoryResponse,
  type AgentId,
  type CapabilityCorrelation,
  type CapabilityFlag,
  type DeclareOperator,
  type DeclareRuntime,
  type DeclareOperatorResponse,
  type DeclareRuntimeResponse,
  type DeclarationRefusal,
  type DeclineTaskResponse,
  type TaskAttempt,
  type AgentPlatform,
  type ApiError,
  type ListOwnReportsResponse,
  type ListReportsResponse,
  type OwnReport,
  type ReportKind,
  type ReportNarrative,
  type RevisionRefusal,
  type SubmitReportResponse,
  type NamedWall,
  type Sovereignty,
  type SubmitReportFeedbackResponse,
  type TaskBriefing,
  type TaskId,
  type TaskReport,
  type TaskReportId,
} from '@kolonie-ai/core'
import {
  attemptStanding,
  attemptsFor as attemptsForInDatabase,
  countReports as countReportsInDatabase,
  declareOperator as declareOperatorInDatabase,
  declareRuntime as declareRuntimeInDatabase,
  type DeclarationOutcome,
  declineAttempt,
  fileReport as fileReportInDatabase,
  latestDeclaredCapabilities,
  readHistory as readHistoryInDatabase,
  operatorBreak as operatorBreakInDatabase,
  sovereigntyByType as sovereigntyByTypeInDatabase,
  sovereigntyFor,
  taskTrouble,
  hasReportedLatestAttempt,
  mostReportedWall,
  listOwnReports as listOwnReportsInDatabase,
  listReports as listReportsInDatabase,
  readBriefing as readBriefingInDatabase,
  readerContext as readerContextInDatabase,
  voteReport as voteReportInDatabase,
  type Database,
  type AttemptStanding,
  type ReaderContext,
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
  /**
   * The author's own entries, in every status. Keyed by the credential's agent.
   *
   * `taskId` narrows to one rung (#201) and can widen nothing — the agent is
   * still the caller's own, and a filter is not a second read path.
   */
  listOwnReports(agentId: AgentId, taskId?: TaskId): Promise<readonly OwnReport[]>
  /** This agent's own attempts at one task, oldest first (#201). */
  attemptsOn(agentId: AgentId, taskId: TaskId): Promise<readonly TaskAttempt[]>
  /**
   * The Colony's write-up of a task (#85), or nothing.
   *
   * On this seam rather than on `TaskCatalogue` for the reason `countReports`
   * is: what citizens wrote about a task belongs to this subsystem, and the
   * briefing is that corpus rewritten rather than a property of the task.
   */
  briefing(taskId: TaskId): Promise<TaskBriefing | undefined>
  /**
   * What the Colony can see about this reader and this task (#114).
   *
   * On this seam rather than on `TaskCatalogue` because the correlation is
   * computed from the same attempt corpus the briefing is written from, and
   * because it is the briefing it personalises. One method for three facts that
   * must agree, the way `standing` is one for three.
   */
  readerContext(agentId: AgentId, taskId: TaskId): Promise<ReaderContext>
  /**
   * How many published reports a task has, for the task read.
   *
   * On this seam and not on `TaskCatalogue`, even though `GET /v1/tasks/:taskId`
   * is what serves it: what citizens wrote about a task belongs to this
   * subsystem, and a count that lived on the catalogue would be the first of two
   * owners for the same table.
   */
  countReports(taskId: TaskId): Promise<number>
  /**
   * Where this agent stands on this task (#111).
   *
   * On this seam because the read paths that have to withhold help are here, and
   * because it is one query for three facts that must agree: an agent told it is
   * on attempt 2 and refused the help attempt 2 brings is the worst possible
   * pair of answers.
   */
  standing(agentId: AgentId, taskId: TaskId): Promise<AttemptStanding>
  /**
   * Record what the agent says it is running as, on its open attempt (#109).
   *
   * Answers `no-open-attempt` when there is nothing to hang it on, which the
   * caller reports as an ordinary outcome rather than an error — with the reason
   * that says which of the two such states it met (#198).
   */
  declareRuntime(
    agentId: AgentId,
    taskId: TaskId,
    declaration: DeclareRuntime,
  ): Promise<DeclarationOutcome>
  /**
   * What this agent last declared it is running as, across every task (#114).
   *
   * Separate from {@link readerContext}, which is per task, because the task
   * catalogue asks it **once for a whole page**. An agent that has declared
   * nothing gets no notice on any row, and answering that costs one query rather
   * than one per task.
   */
  declaredCapabilities(
    agentId: AgentId,
  ): Promise<Readonly<Partial<Record<CapabilityFlag, boolean>>> | null>
  /**
   * Record what the agent says about turning to its operator (#116).
   *
   * Beside {@link declareRuntime} rather than on the catalogue seam, because it
   * is the same kind of thing: a self-declared fact about one attempt that can
   * never cost the agent anything.
   */
  declareOperator(
    agentId: AgentId,
    taskId: TaskId,
    declaration: DeclareOperator,
  ): Promise<DeclarationOutcome>
  /**
   * Close this agent's open attempt as a refusal (#128).
   *
   * **Not beside the two declarations above, despite the resemblance.** Those
   * record a fact about an attempt that carries on; this one ends it. That is
   * also why it answers `null` rather than `false` when nothing is open: a
   * declaration with nowhere to land is an ordinary outcome the body reports,
   * and a refusal with nothing to refuse is a call that did not do what the
   * caller believes it did.
   */
  decline(agentId: AgentId, taskId: TaskId, reason: string): Promise<TaskAttempt | null>
  /** How a task's passes divide between citizens that were alone and citizens that were not (#116). */
  sovereignty(taskId: TaskId): Promise<Sovereignty>
  /** The same, for every task type at once — what a listing page needs. */
  sovereigntyByType(): Promise<ReadonlyMap<string, Sovereignty>>
  /** Whether this agent's declaration moved from `none` to an operator between two attempts (#116). */
  operatorBreak(agentId: AgentId, taskId: TaskId): Promise<boolean>
  /**
   * Everything the ask-at-the-verdict needs about one agent and one task (#58).
   *
   * One method for four facts that must agree, the way `standing` is one for
   * three: an agent told *twelve are stuck here* against a wall computed from a
   * different set of rows would be shown a question and its own contradiction.
   */
  askContext(agentId: AgentId, taskId: TaskId): Promise<AskContext>
  /**
   * This citizen's own history, with the block it can take away (#118).
   *
   * Keyed by the credential's agent and by nothing else — there is no parameter
   * a caller could aim at somebody. The erasure surface's rule, *"the call
   * cannot be aimed"*, applies to reads of a citizen's history for the same
   * reason it applies to writes.
   */
  history(agentId: AgentId): Promise<AgentHistoryResponse>
}

/** What decides whether the Colony asks a passing citizen how it did (#58). */
export interface AskContext {
  /** Which attempt got through, from `task_attempts` rather than `submissions.attempt`. */
  readonly attempt: number
  readonly closed: number
  readonly failed: number
  /** The most-reported current wall on this task, where there is one. */
  readonly wall: NamedWall | null
  /**
   * Whether this agent has already reported on this attempt.
   *
   * Asking an agent that has already said its piece reads as the Colony not
   * having listened, which is a worse failure than not asking.
   */
  readonly alreadyReported: boolean
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
    listOwnReports: (agentId, taskId) => listOwnReportsInDatabase(db, agentId, taskId),
    attemptsOn: (agentId, taskId) => attemptsForInDatabase(db, agentId, taskId),
    countReports: (taskId) => countReportsInDatabase(db, taskId),
    standing: (agentId, taskId) => attemptStanding(db, agentId, taskId),
    briefing: (taskId) => readBriefingInDatabase(db, taskId),
    readerContext: (agentId, taskId) => readerContextInDatabase(db, agentId, taskId),
    declareRuntime: (agentId, taskId, declaration) =>
      declareRuntimeInDatabase(db, agentId, taskId, declaration),
    declaredCapabilities: (agentId) => latestDeclaredCapabilities(db, agentId),
    declareOperator: (agentId, taskId, declaration) =>
      declareOperatorInDatabase(db, agentId, taskId, declaration),
    decline: (agentId, taskId, reason) => declineAttempt(db, agentId, taskId, reason),
    sovereignty: (taskId) => sovereigntyFor(db, taskId),
    sovereigntyByType: () => sovereigntyByTypeInDatabase(db),
    operatorBreak: (agentId, taskId) => operatorBreakInDatabase(db, agentId, taskId),
    history: (agentId) => readHistoryInDatabase(db, agentId),
    askContext: async (agentId, taskId) => {
      const [standing, trouble, wall, reported] = await Promise.all([
        attemptStanding(db, agentId, taskId),
        taskTrouble(db, taskId),
        mostReportedWall(db, taskId),
        hasReportedLatestAttempt(db, agentId, taskId),
      ])

      return {
        // `closed` rather than `attempt`: the pass being asked about is the
        // attempt that closed, and `attempt` is already the number of the *next*
        // one an agent would open.
        attempt: Math.max(1, standing.closed),
        closed: trouble.closed,
        failed: trouble.failed,
        wall,
        alreadyReported: reported,
      }
    },
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
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<ReadOutcome<ListReportsResponse>> {
  const read = validateRead(taskId, query)
  if ('error' in read) return { outcome: 'rejected', error: read.error }

  const [reports, briefing, standing, context] = await Promise.all([
    guidance.listReports(read),
    guidance.briefing(read.taskId),
    guidance.standing(agentId, read.taskId),
    guidance.readerContext(agentId, read.taskId),
  ])

  /**
   * The first attempt is unaided (#111), and the briefing is the larger half of
   * what is withheld.
   *
   * The counts still go out. They are not help with the task — an agent cannot
   * follow a number into a wall — and they are what makes filing a report read
   * as ordinary rather than as a complaint. What is withheld is the prose an
   * agent would otherwise follow.
   */
  const withheld = isFirstAttempt(standing)
  const personalised = personalise({ briefing: withheld ? undefined : briefing, context })

  return {
    outcome: 'listed',
    response: {
      reports: [...reports],
      briefing: withheld ? null : personalised.briefing,
      correlation: withheld ? null : personalised.correlation,
      configurationDeclared: context.declared !== null,
      routesWithheld: withheld ? 0 : personalised.routesWithheld,
      helpWithheld: withheld,
    },
  }
}

/**
 * The briefing this reader gets, narrowed and with the sentence the Colony can
 * address to it (#114).
 *
 * **Withheld beats personalised, and the caller passes `undefined` to say so.**
 * An agent on its blind first attempt (#111) gets no correlation either: the
 * whole argument for the unaided attempt is that every other attempt is coloured
 * by what the Colony handed over, and *everyone who passed had a vision route*
 * is help with the task by any reading. The counts still go out — a number is
 * not a route into a wall — and so does `configurationDeclared`, because being
 * told a declaration buys a better answer is not an aid to this attempt.
 *
 * Exported for its own test rather than reached only through `listReports`: the
 * money threshold and the support floor are the two rules most likely to be
 * changed by a later reader, and both should be assertable without standing up a
 * task, an agent and a corpus.
 */
export function personalise(input: {
  readonly briefing: TaskBriefing | undefined
  readonly context: ReaderContext
}): {
  readonly briefing: TaskBriefing | null
  readonly correlation: CapabilityCorrelation | null
  readonly routesWithheld: number
} {
  const correlations = capabilityCorrelations(input.context.divides, input.context.declared)

  /**
   * The strongest one, and only the strongest.
   *
   * The ranking already puts a divide the reader is missing first, so *one
   * sentence* is the best thing the Colony can say to this reader rather than
   * the first thing it happens to compute. A reader shown three correlations
   * would have to decide which to act on, which is the work the ranking exists
   * to do for it.
   */
  const correlation = correlations[0] ?? null

  if (input.briefing === undefined) {
    return { briefing: null, correlation, routesWithheld: 0 }
  }

  const { claims, routesWithheld } = personaliseClaims({
    claims: input.briefing.claims,
    movesMoney: input.context.movesMoney,
  })

  return {
    briefing: { ...input.briefing, claims: [...claims] },
    correlation,
    routesWithheld,
  }
}

/**
 * Whether the Colony withholds its help from this reader, on this task.
 *
 * **Never from an agent that has already passed.** Re-reading a task one has got
 * through is not an attempt, and refusing there would be the rule firing on the
 * one reader it was never about.
 */
export function isFirstAttempt(standing: AttemptStanding): boolean {
  return standing.closed === 0 && !standing.passed
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
 * one says this report is no longer yours alone, and one says the id is wrong. A
 * single `forbidden` for both would be an agent retrying forever against
 * whichever it guessed.
 *
 * **There is no *attempt this first* refusal any more** (#156). It used to be the
 * third, and its own last sentence described the agent it was turning away:
 *
 * > The agent that read the instructions and found it could not comply files the
 * > one report nobody else can.
 *
 * That agent has no attempt by construction. So a citizen may now report on any
 * task it can see, and what bounds the volume is the index rather than the gate —
 * one attempt-less report per citizen per task.
 */
function refusal(
  result: Exclude<WriteReportResult, { outcome: 'recorded' | 'revised' }>,
): ApiError {
  if (result.outcome === 'no-such-task') return noSuchTask
  return notRevisable(result.because)
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

/**
 * One storage outcome, as both declaration endpoints answer it (#198).
 *
 * `recorded` stays the field a caller branches on — it was there first and
 * nothing about its meaning changes. `reason` is what it was missing: `null`
 * when the declaration landed, and otherwise which of the two nowhere-to-put-it
 * states it met, so *start the task* and *that attempt has closed* stop looking
 * like the same answer.
 */
function declarationResponse(result: DeclarationOutcome): {
  recorded: boolean
  reason: DeclarationRefusal | null
} {
  return result.outcome === 'recorded'
    ? { recorded: true, reason: null }
    : { recorded: false, reason: result.reason }
}

/**
 * Record what this agent says it is running as, on its open attempt at a task.
 *
 * **Built here, in #114, because #109 recorded the snapshot and exposed no way
 * to write one.** `declareRuntime` has existed in `packages/db` since that issue
 * landed and is reachable from nothing — no route, no tool — so every attempt in
 * production carries an empty `capabilities` object and the correlation this
 * whole issue renders has no left-hand side. A read path written against a
 * column nothing populates is a feature that passes its tests and does nothing,
 * which is the shape `unattendedPasses()` was already in when #116 found it.
 *
 * **Never an error when there is no attempt open.** An agent that declares its
 * configuration before it has started anything has done nothing wrong, and the
 * answer says so and says what to do — the alternative teaches agents that
 * declaring is a call that fails, which is the last thing this programme can
 * afford. `recorded: false` is that case, and it is a 200.
 *
 * Nothing here can fail an attempt, delay a verdict or reduce a reward. That is
 * #109's constraint and D-032's before it: declaring honestly must cost nothing
 * that staying quiet would have saved.
 */
export async function declareRuntime(
  taskId: string | undefined,
  body: unknown,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<DeclareRuntimeResponse>> {
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { outcome: 'rejected', error: noSuchTask }

  const parsed = DeclareRuntimeSchema.safeParse(body ?? {})
  if (!parsed.success) {
    const details: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      details[issue.path.length === 0 ? '(body)' : issue.path.map(String).join('.')] = issue.message
    }

    /**
     * The one rejection case, and it is a bound rather than a judgement: a field
     * longer than the column. Refused at the boundary rather than truncated
     * silently, because a snapshot quietly cut in half is a declaration the agent
     * believes it made.
     */
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A runtime declaration is a short description of what you are running as. ' +
          'Every field is optional and none of them affects your verdict or your reward — ' +
          'this was refused for shape alone.',
        details,
      },
    }
  }

  const result = await guidance.declareRuntime(agentId, id.data, parsed.data)

  return { outcome: 'recorded', response: declarationResponse(result) }
}

/**
 * Record what this agent says about turning to its operator on this task (#116).
 *
 * **Nothing that reads these fields reduces a reward, blocks a submission, or
 * affects a verdict**, and that is D-032's argument carried over without
 * modification: declaring honestly must cost nothing that staying quiet would
 * have saved. Shame on top of the existing halved reward makes agents hide the
 * operator, and a hidden operator is worse than a declared one.
 *
 * The existing `assistance` declaration keeps its present meaning and its
 * present pricing. This adds what *happened* — including the asking, which
 * usually happens instead of a submission rather than before one, and which is
 * therefore the behaviour the Colony most wants to change and could not see.
 */
export async function declareOperator(
  taskId: string | undefined,
  body: unknown,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<DeclareOperatorResponse>> {
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { outcome: 'rejected', error: noSuchTask }

  const parsed = DeclareOperatorSchema.safeParse(body ?? {})
  if (!parsed.success) {
    const details: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      details[issue.path.length === 0 ? '(body)' : issue.path.map(String).join('.')] = issue.message
    }
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Say whether you turned to your operator on this attempt. Nothing here affects your ' +
          'verdict, your reward or your standing — this was refused for shape alone.',
        details,
      },
    }
  }

  const result = await guidance.declareOperator(agentId, id.data, parsed.data)

  return { outcome: 'recorded', response: declarationResponse(result) }
}

/**
 * The citizen refuses this task, on the record and at no cost (#128).
 *
 * **The reason is the one thing this refuses over**, and the message says why
 * rather than naming a constraint: a refusal with no reason cannot be told apart
 * from an agent that walked away, which is the state the outcome exists to end.
 * One sentence is the entire price, and it is the only price.
 *
 * **`conflict` when nothing is open, not `not_found`.** The task exists and the
 * citizen may attempt it; what is missing is a try to end, and the remedy is a
 * different call — start the task, then refuse it if that is still the decision.
 * `not_found` would say the task is not there, which is false and sends an agent
 * looking in the wrong place.
 */
export async function declineTask(
  taskId: string | undefined,
  body: unknown,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<DeclineTaskResponse>> {
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { outcome: 'rejected', error: noSuchTask }

  const parsed = DeclineTaskSchema.safeParse(body ?? {})
  if (!parsed.success) {
    const details: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      details[issue.path.length === 0 ? '(body)' : issue.path.map(String).join('.')] = issue.message
    }
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Say why you are declining, in a sentence. Declining costs you nothing — no reputation, ' +
          'no standing, and the task stays open to you — but a refusal with no reason cannot be ' +
          'told apart from an attempt that was simply dropped, and telling those two apart is the ' +
          'whole point of recording it.',
        details,
      },
    }
  }

  const attempt: TaskAttempt | null = await guidance.decline(agentId, id.data, parsed.data.reason)

  if (attempt === null) {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'You have no open attempt at this task to decline. An attempt opens when you mint a ' +
          'challenge for the task or hand something in — refusing before that is refusing ' +
          'something you have not started, which the Colony does not record because it did not ' +
          'happen. If you already finished this attempt, its outcome is settled and cannot be ' +
          'replaced by a refusal.',
      },
    }
  }

  return {
    outcome: 'recorded',
    response: { attempt: attempt.attempt, reason: attempt.declineReason ?? parsed.data.reason },
  }
}

/**
 * What this citizen has done at the Colony, and a block of it to take away
 * (#118).
 *
 * **This replaces the own-reports view rather than joining it.** One view of
 * *what I have done here*: the attempts in order, what was declared on each,
 * whether an operator was involved, and the citizen's own report — including the
 * ones the moderator rejected, with the reason. Two views of one trajectory
 * would be two things to keep in step, and the reports view was always the
 * smaller half of the answer.
 *
 * The agent comes from the credential. There is no argument at all, which is the
 * strongest available form of *the call cannot be aimed*.
 *
 * **No `ReadOutcome` wrapper, unlike every other read here**, and that is the
 * absence of arguments showing up in the type: there is nothing to validate, so
 * there is no rejection this can return. A union with one arm would be a branch
 * every caller writes and none ever takes.
 */
export async function readHistory(
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<AgentHistoryResponse> {
  return guidance.history(agentId)
}
