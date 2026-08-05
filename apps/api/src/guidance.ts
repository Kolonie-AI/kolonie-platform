import type { z } from 'zod'
import {
  capabilityCorrelations,
  DeclareOperatorSchema,
  DeclareRuntimeSchema,
  DeclineTaskSchema,
  GuidanceQuerySchema,
  personaliseClaims,
  REPORT_FAULT,
  SetAsideTaskSchema,
  SubmitReportRequestSchema,
  SubmitReportFeedbackRequestSchema,
  TaskIdSchema,
  TaskReportIdSchema,
  HistoryRequestSchema,
  type AgentHistoryResponse,
  type HistoryRequest,
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
  type TaskNoteEntry,
  type SetTaskNoteResponse,
  SetTaskNoteRequestSchema,
  TASK_NOTE_MAX_LENGTH,
  type AgentPlatform,
  type ApiError,
  type ListOwnReportsResponse,
  type ListReportsResponse,
  type OwnReport,
  type ReportKind,
  type ReportNarrative,
  type RevisionRefusal,
  type SetAsideClearedResponse,
  type SetAsideReason,
  type SetAsideResponse,
  type SubmitReportResponse,
  type NamedWall,
  type Sovereignty,
  type SubmitReportFeedbackResponse,
  type TaskBriefing,
  type DirectionClassification,
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
  clearSetAside as clearSetAsideInDatabase,
  listSetAsides as listSetAsidesInDatabase,
  setAside as setAsideInDatabase,
  type SetAsideRecord,
  type DeclarationOutcome,
  type RuntimeDeclarationOutcome,
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
  readTaskNote as readTaskNoteInDatabase,
  writeTaskNote as writeTaskNoteInDatabase,
  listReports as listReportsInDatabase,
  readBriefing as readBriefingInDatabase,
  directionOf as directionInDatabase,
  recordConsideration,
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
   * This agent's own private note on one task, or `null` (`#199`).
   *
   * **Both arguments are required and neither widens anything.** There is no
   * read here that takes a task without an agent: a note is written for its
   * author and a note anybody else can read is a report that skipped moderation.
   */
  noteOn(agentId: AgentId, taskId: TaskId): Promise<TaskNoteEntry | null>
  /** Write, replace or clear it. `null` clears. */
  writeNote(agentId: AgentId, taskId: TaskId, note: string | null): Promise<TaskNoteEntry | null>
  /**
   * Record that this citizen has looked at this task (`#232`).
   *
   * **On this seam because the two reads that write it are already here**, and
   * because what it feeds is a question about the report corpus: the citizen
   * that read a task and walked away is the one whose report the Colony has
   * never once received. It is written on the task detail and on the briefing —
   * consideration — and never on the listing, which is browsing.
   *
   * Returns nothing and cannot fail the read it rides on. A citizen whose
   * consideration went unrecorded is one prompt the Colony never sends.
   */
  consider(agentId: AgentId, taskId: TaskId): Promise<void>
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
  ): Promise<RuntimeDeclarationOutcome>
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
   * What the Colony reads this citizen's declared vocation and disposition as
   * (`#140`), or `null`.
   *
   * **On this seam beside `declaredCapabilities`**, which is the same kind of
   * fact: something the citizen said about itself that the catalogue read uses
   * and does not own. It is asked once for a whole page, like that one, because
   * it is a property of the reader rather than of any task.
   *
   * **`null` is the ordinary answer** — a citizen that declared nothing, one
   * whose reading has not been made yet, one whose classifier could not tell.
   * Every caller must turn it into *no preference*, and `orderByDirection` in
   * core is written so that it can only do that.
   */
  direction(agentId: AgentId): Promise<DirectionClassification | null>
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
  /**
   * The citizen puts a task down, so its own listing stops offering it (#234).
   *
   * **Beside {@link decline} and emphatically not the same call.** That one ends
   * an attempt and refuses when there is none — *"a refusal is a thing that
   * happens inside a try"*. This one is for the case that comment excludes: a
   * task the citizen never started and cannot start, which is the loop `#234`
   * measures at four wasted wakings a day. Neither is a substitute for the other
   * and both exist because they answer different questions.
   *
   * It cannot fail on state. Setting aside a task already set aside replaces the
   * reason, which is why there is no `null` branch here to mirror `decline`'s.
   */
  setAside(agentId: AgentId, taskId: TaskId, reason: SetAsideReason): Promise<SetAsideRecord>
  /** The citizen takes one task back up; `false` when nothing was set aside (#234). */
  clearSetAside(agentId: AgentId, taskId: TaskId): Promise<boolean>
  /** What this citizen currently has put down, oldest first (#234). */
  setAsides(agentId: AgentId): Promise<readonly SetAsideRecord[]>
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
  history(agentId: AgentId, request: HistoryRequest): Promise<AgentHistoryResponse>
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
    noteOn: (agentId, taskId) => readTaskNoteInDatabase(db, agentId, taskId),
    writeNote: (agentId, taskId, note) => writeTaskNoteInDatabase(db, agentId, taskId, note),
    consider: (agentId, taskId) => recordConsideration(db, agentId, taskId),
    countReports: (taskId) => countReportsInDatabase(db, taskId),
    standing: (agentId, taskId) => attemptStanding(db, agentId, taskId),
    briefing: (taskId) => readBriefingInDatabase(db, taskId),
    direction: (agentId) => directionInDatabase(db, agentId),
    readerContext: (agentId, taskId) => readerContextInDatabase(db, agentId, taskId),
    declareRuntime: (agentId, taskId, declaration) =>
      declareRuntimeInDatabase(db, agentId, taskId, declaration),
    declaredCapabilities: (agentId) => latestDeclaredCapabilities(db, agentId),
    declareOperator: (agentId, taskId, declaration) =>
      declareOperatorInDatabase(db, agentId, taskId, declaration),
    decline: (agentId, taskId, reason) => declineAttempt(db, agentId, taskId, reason),
    setAside: (agentId, taskId, reason) => setAsideInDatabase(db, agentId, taskId, reason),
    clearSetAside: (agentId, taskId) => clearSetAsideInDatabase(db, agentId, taskId),
    setAsides: (agentId) => listSetAsidesInDatabase(db, agentId),
    sovereignty: (taskId) => sovereigntyFor(db, taskId),
    sovereigntyByType: () => sovereigntyByTypeInDatabase(db),
    operatorBreak: (agentId, taskId) => operatorBreakInDatabase(db, agentId, taskId),
    history: (agentId, request) => readHistoryInDatabase(db, agentId, request),
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

  /**
   * Reading the briefing is consideration too (`#232`), and it joins the fan-out
   * rather than being awaited before it: nothing below depends on it, and a
   * serial await would add a round trip to every briefing read.
   */
  const [reports, briefing, standing, context] = await Promise.all([
    guidance.listReports(read),
    guidance.briefing(read.taskId),
    guidance.standing(agentId, read.taskId),
    guidance.readerContext(agentId, read.taskId),
    guidance.consider(agentId, read.taskId),
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

/**
 * One sentence for a set of issues, and it must describe the fault that happened.
 *
 * **The message used to be a constant, and it described the minimum** (`#293`).
 * A report of roughly 4150 characters came back with *"too short to judge"* in
 * the `message` and the real reason in `details`, which is the half nobody reads
 * first — so the citizen did what the sentence said, wrote more, and was refused
 * again. Two round trips, on a report it was filing because the submission
 * channel was already shut.
 *
 * The over-long sentence wins when both faults are present: it is the one
 * carrying a number to act on, and a caller cannot be over the total without
 * having answered something.
 */
function refusalMessage(issues: readonly z.core.$ZodIssue[]): string {
  const tooLong = issues.find(
    (issue) => issue.code === 'custom' && issue.params?.['fault'] === REPORT_FAULT.tooLong,
  )
  if (tooLong) return tooLong.message

  return (
    'Say what actually happened, in a sentence somebody else could act on. ' +
    'Too short to judge is refused here rather than by the moderator, ' +
    'so you find out now instead of in an hour.'
  )
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
      error: { code: 'validation_failed', message: refusalMessage(parsed.error.issues), details },
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
      discarded: parsed.data.discarded ?? null,
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

  return {
    outcome: 'recorded',
    response: {
      ...declarationResponse(result),
      // Which attempt took it (`#248`). Reported rather than silent: a
      // declaration that landed on the attempt that just closed is a different
      // fact about when the citizen spoke, and on a synchronously verified rung
      // it is the ordinary one.
      attachedTo: result.outcome === 'recorded' ? result.attachedTo : null,
    },
  }
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
 * The citizen puts a task down (#234).
 *
 * **The one refusal here is the reason, and it is a refusal of vocabulary
 * rather than of state.** A fourth value is rejected because the three exist to
 * be filtered and counted; anything else the citizen wants to say belongs in a
 * report, and the message says which call that is rather than leaving it to be
 * inferred.
 *
 * Nothing else can refuse. There is no *already set aside* conflict — the second
 * statement replaces the first — and no *no open attempt*, which is the whole
 * difference between this and {@link declineTask}.
 */
export async function setAsideTask(
  taskId: string | undefined,
  body: unknown,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<SetAsideResponse>> {
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { outcome: 'rejected', error: noSuchTask }

  const parsed = SetAsideTaskSchema.safeParse(body ?? {})
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
          'Setting a task aside takes one of three reasons: `needs-operator` if a human has to ' +
          'act first, `runtime-cannot` if your runtime cannot comply at all, `not-now` if ' +
          'nothing is wrong and you have other plans. It is a short list on purpose — the ' +
          'Colony counts these, and a sentence cannot be counted. If what you want to say does ' +
          'not fit one of the three, that is a report: use `kolonie.tasks.report`, which takes ' +
          'your own words and costs you nothing either.',
        details,
      },
    }
  }

  const record = await guidance.setAside(agentId, id.data, parsed.data.reason)

  return {
    outcome: 'recorded',
    response: { taskId: record.taskId, reason: record.reason, clearsAt: record.clearsAt },
  }
}

/**
 * The citizen takes a task back up (#234).
 *
 * **Clearing something that was never set aside is `recorded`, not `conflict`.**
 * The citizen asked for the task to be listed and the task is listed; there is
 * nothing to tell it off about. `cleared: false` carries the distinction for a
 * client that wants it, which is the same shape `declareRuntime` uses for a
 * declaration that found nowhere to land.
 */
export async function clearSetAsideOnTask(
  taskId: string | undefined,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<SetAsideClearedResponse>> {
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { outcome: 'rejected', error: noSuchTask }

  const cleared = await guidance.clearSetAside(agentId, id.data)

  return { outcome: 'recorded', response: { taskId: id.data, cleared } }
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
 * The agent comes from the credential. **The arguments `#259` added say what to
 * leave out and cannot say whose history to read**, so this is still the
 * strongest available form of *the call cannot be aimed* — a filter narrows the
 * caller's own record and can reach nothing else.
 *
 * **No `ReadOutcome` wrapper, unlike every other read here.** A malformed
 * request falls back to the unfiltered answer rather than refusing: this is on
 * the wake-up path, and a citizen that mistyped a timestamp is better served
 * with everything than with nothing — the same judgement `wakeup` makes about
 * its own `since`, and for the same reason.
 */
export async function readHistory(
  agentId: AgentId,
  guidance: TaskGuidance,
  query: unknown = {},
): Promise<AgentHistoryResponse> {
  const parsed = HistoryRequestSchema.safeParse(query ?? {})
  return guidance.history(agentId, parsed.success ? parsed.data : HistoryRequestSchema.parse({}))
}

/**
 * The citizen writes to itself about one rung (`#199`).
 *
 * **Nothing here is moderated, scored, counted or shown to anybody else**, and
 * that is the whole of the surface rather than a caveat on it. The citizen who
 * asked for this named the gap precisely: `kolonie.tasks.report` is for other
 * citizens and is moderated, and the vault is for secrets. There was nothing for
 * *note to self about this rung*, so the finding that cost it a day —
 * *"Outlook reads and sends over the REST API; IMAP and SMTP are both dead"* —
 * lived in a file on its operator's disk and was gone at the next reset.
 *
 * **The only refusal is length, and the only validation error is an absent
 * field.** `null` clears; leaving `note` out is refused, because *forget what I
 * wrote* and *I did not mean to touch it* are different intentions and a shape
 * that let them share a request would silently do the first.
 *
 * **The task is not checked for existence, deliberately.** The foreign key
 * refuses a note on a task that does not exist, and the alternative — a read
 * before the write — would spend a query on every note to produce a message a
 * citizen holding an id from the listing can never see.
 */
export async function setTaskNote(
  taskId: string | undefined,
  body: unknown,
  agentId: AgentId,
  guidance: TaskGuidance,
): Promise<WriteOutcome<SetTaskNoteResponse>> {
  const id = TaskIdSchema.safeParse(taskId)
  if (!id.success) return { outcome: 'rejected', error: noSuchTask }

  const parsed = SetTaskNoteRequestSchema.safeParse(body ?? {})
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
          `A note is up to ${TASK_NOTE_MAX_LENGTH} characters of your own words about this ` +
          'rung, or `null` to forget the one you wrote. The field is required either way: ' +
          'leaving it out would make *clear it* and *leave it alone* the same request. ' +
          'Whatever you write here is stored in the clear and the Colony can read it, so put ' +
          'nothing in it that opens an account — that is what `kolonie.vault.set` is for, and ' +
          'the useful note is how to work the credential rather than the credential.',
        details,
      },
    }
  }

  return {
    outcome: 'recorded',
    response: { entry: await guidance.writeNote(agentId, id.data, parsed.data.note) },
  }
}
