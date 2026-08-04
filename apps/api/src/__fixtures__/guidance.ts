import { randomUUID } from 'node:crypto'
import {
  bioMaterial,
  memoryBlock,
  ServedBriefingClaimSchema,
  OwnReportSchema,
  TaskAttemptSchema,
  TaskBriefingSchema,
  TaskReportSchema,
  type AgentHistoryResponse,
  type AgentId,
  type HistoryAttempt,
  type HistoryRequest,
  type TaskHistory,
  type DeclareOperator,
  type DeclareRuntime,
  type SetAsideReason,
  type Sovereignty,
  type ServedBriefingClaim,
  type OwnReport,
  type TaskAttempt,
  type TaskId,
  type TaskBriefing,
  type TaskReport,
} from '@kolonie-ai/core'
import type {
  AttemptStanding,
  DeclarationOutcome,
  RuntimeDeclarationOutcome,
  ReaderContext,
  VoteReportResult,
  WriteReportResult,
} from '@kolonie-ai/db'
import type { AskContext, GuidanceRead, GuidanceWrite, TaskGuidance } from '../guidance.js'

/**
 * A guidance store that records what it was asked and answers with what it was
 * told.
 *
 * Deliberately not an in-memory reimplementation of the entitlement rules, for
 * the reason `fakeCatalogue` gives about the skill gate. `apps/api` is
 * responsible for validating the body, taking the agent from the credential
 * rather than the request, and turning each refusal into the right code — and a
 * fake that also enforced the rules would let a test pass while the route asked
 * on behalf of the wrong agent. Whether an agent has an attempt, and whether a
 * revision is allowed, are asserted in `packages/db` against a real Postgres.
 *
 * **Half the surface it used to have** (#110). It carried a `kind` on every
 * recorded call because there were two write paths and two read paths to tell
 * apart; there is one of each now, and the kind is a property of the answer
 * rather than of the question.
 */
export interface FakeGuidance extends TaskGuidance {
  /** Every write the routes have sent, in order. */
  readonly writes: () => GuidanceWrite[]
  /** The last one, which is what a single-call test is asking about. */
  readonly lastWrite: () => GuidanceWrite | undefined
  /** Every read the routes have sent, in order. */
  readonly reads: () => GuidanceRead[]
  /**
   * Every task read the routes counted as consideration (`#232`).
   *
   * Recorded rather than answered, because the assertion this fixture exists for
   * is negative: the *listing* must write nothing, and only a recorder can show
   * that nothing arrived.
   */
  readonly considered: () => { agentId: AgentId; taskId: TaskId }[]
  readonly lastRead: () => GuidanceRead | undefined
  /**
   * What the next write answers with.
   *
   * `not-revisable` carries a reason, so it is set as the whole result rather
   * than as a bare outcome.
   */
  readonly answersWrite: (
    result: WriteOutcomeName | Extract<WriteReportResult, { outcome: 'not-revisable' }>,
  ) => void
  /** What the next report read answers with. */
  readonly answersReports: (reports: readonly TaskReport[]) => void
  readonly answersVoteReport: (outcome: VoteReportResult['outcome']) => void
  /** What the author's own read answers with. */
  readonly answersOwnReports: (reports: readonly OwnReport[]) => void
  readonly answersOwnAttempts: (attempts: readonly TaskAttempt[]) => void
  /** What `GET /v1/tasks/:taskId` is told about how many reports a task has. */
  readonly answersReportCount: (count: number) => void
  /**
   * Where the caller stands on the task (#111).
   *
   * Defaults to a *second* attempt, so a test that says nothing about the
   * standing asserts the ordinary aided path. The blind first attempt is the
   * special case and the tests about it say so — a default of attempt 1 would
   * silently withhold help in every test that forgot.
   */
  readonly answersStanding: (standing: AttemptStanding) => void
  /**
   * What the task-scoped reads serve as the Colony's write-up (#85).
   *
   * `undefined` by default, which is the state of every task before the
   * synthesis has run — so a test that says nothing about the briefing asserts
   * the *not written up yet* path, which is the one most likely to be got wrong.
   */
  readonly answersBriefing: (briefing: TaskBriefing | undefined) => void
  /**
   * What the Colony can see about the reader and the task (#114).
   *
   * Defaults to nothing known: no divides, no declaration, no money. So a test
   * that says nothing about personalisation asserts the unpersonalised path,
   * which is what every reader got before this issue and what a reader that has
   * never declared still gets.
   */
  readonly answersReaderContext: (context: ReaderContext) => void
  /** Every runtime declaration the routes have sent, in order. */
  readonly declarations: () => { agentId: AgentId; taskId: TaskId; declaration: DeclareRuntime }[]
  /**
   * Whether the next declaration finds an attempt to hang itself on.
   *
   * `true` by default. The `false` case is #109's *declared before starting*,
   * which is an outcome rather than an error and has its own test.
   */
  readonly answersDeclareRuntime: (result: RuntimeDeclarationOutcome) => void
  /**
   * The operator declaration's outcome, set apart from the runtime one (`#248`).
   *
   * They stopped being the same shape when the runtime declaration gained a
   * grace period: it may attach to a settled attempt and says which it found,
   * while an operator declaration describes what happened during a try and has
   * nothing to attach to once the try is over.
   */
  readonly answersDeclareOperator: (result: DeclarationOutcome) => void
  /** Every operator declaration the routes have sent, in order. */
  readonly operatorDeclarations: () => {
    agentId: AgentId
    taskId: TaskId
    declaration: DeclareOperator
  }[]
  /**
   * How a task's passes divide (#116).
   *
   * Defaults to nothing passed at all, which is the *nobody has managed this
   * alone yet* branch — and which was the state of **every** task in production
   * when this was written: not one pass had ever declared `none`.
   */
  readonly answersSovereignty: (sovereignty: Sovereignty) => void
  /** Whether the reader's declaration moved from `none` to an operator (#116). */
  readonly answersOperatorBreak: (broke: boolean) => void
  /**
   * What decides whether a passing citizen is asked how it did (#58).
   *
   * Defaults to a first-try pass on a task nobody has closed an attempt on,
   * which is the *asked nothing* case — so a test that says nothing about the
   * ask asserts the silence, which is the behaviour most of the Colony's readers
   * get and the one most easily broken by accident.
   */
  readonly answersAskContext: (context: AskContext) => void
  /**
   * The citizen's own trajectory (#118).
   *
   * Defaults to nothing attempted, which is the *told so plainly* case — an
   * agent at any standing may call this, including one that has passed nothing.
   */
  readonly answersHistory: (history: AgentHistoryResponse) => void
  /**
   * Every narrowing the routes forwarded, in order (`#259`).
   *
   * Recorded rather than asserted through the response, because the response is
   * the fixture's own and would prove nothing about what reached it — and the
   * one thing worth proving is that `full=true` in a query string arrives as a
   * boolean.
   */
  readonly historyRequests: () => HistoryRequest[]
  /** Every refusal the routes have sent, in order (#128). */
  readonly declines: () => { agentId: AgentId; taskId: TaskId; reason: string }[]
  /**
   * Whether the next refusal finds an open attempt to close.
   *
   * `true` by default. The `false` case is a refusal with nothing to refuse,
   * which the API answers with `conflict` rather than a body — unlike the two
   * declarations, where nowhere to land is an ordinary 200.
   */
  readonly answersDecline: (closed: boolean) => void
  /** Every task the routes have put down, in order (#234). */
  readonly setAsideCalls: () => { agentId: AgentId; taskId: TaskId; reason: SetAsideReason }[]
  /** Every task the routes have taken back up, in order (#234). */
  readonly takeUpCalls: () => { agentId: AgentId; taskId: TaskId }[]
  /**
   * Whether the next take-up finds something to undo.
   *
   * `true` by default. The `false` case is not an error — the citizen asked for
   * the task to be listed and it is — so unlike `answersDecline` both branches
   * are a 200 and the difference is one boolean in the body.
   */
  readonly answersTakeUp: (cleared: boolean) => void
}

type WriteOutcomeName = WriteReportResult['outcome']

export function fakeGuidance(): FakeGuidance {
  const writes: GuidanceWrite[] = []
  const reads: GuidanceRead[] = []
  let writeResult: WriteOutcomeName | Extract<WriteReportResult, { outcome: 'not-revisable' }> =
    'recorded'
  let reports: readonly TaskReport[] = []
  let voteOutcome: VoteReportResult['outcome'] = 'recorded'
  let ownReports: readonly OwnReport[] = []
  let ownAttempts: readonly TaskAttempt[] = []
  /** Every task read that counted as consideration (`#232`), in order. */
  const considered: { agentId: AgentId; taskId: TaskId }[] = []
  let reportCount = 0
  let standing: AttemptStanding = { closed: 1, attempt: 2, passed: false }
  let briefing: TaskBriefing | undefined
  let context: ReaderContext = { divides: [], declared: null, movesMoney: false }
  const declarations: { agentId: AgentId; taskId: TaskId; declaration: DeclareRuntime }[] = []
  let declarationRecorded: DeclarationOutcome = { outcome: 'recorded' }
  // The runtime declaration has its own outcome since `#248`: it says which
  // attempt took it, and `settled` is the ordinary answer on a fast rung.
  let runtimeRecorded: RuntimeDeclarationOutcome = { outcome: 'recorded', attachedTo: 'open' }
  const operatorDeclarations: {
    agentId: AgentId
    taskId: TaskId
    declaration: DeclareOperator
  }[] = []
  const declines: { agentId: AgentId; taskId: TaskId; reason: string }[] = []
  let declineCloses = true
  const setAsides: { agentId: AgentId; taskId: TaskId; reason: SetAsideReason }[] = []
  const takeUps: { agentId: AgentId; taskId: TaskId }[] = []
  let takeUpClears = true
  let sovereignty: Sovereignty = { passes: 0, unattended: 0, share: null }
  let operatorBroke = false
  /**
   * Set explicitly by a test about the trajectory itself; otherwise derived from
   * whatever `answersOwnReports` was given.
   *
   * **Derived rather than defaulted to empty**, because that is the relationship
   * in the real read: `#118` replaced the reports view rather than joining it, so
   * a report an author filed *is* part of its history. A fake where the two could
   * disagree would let a test assert an author sees its own rejection while the
   * real read had stopped serving it.
   */
  let history: AgentHistoryResponse | undefined
  const historyRequests: HistoryRequest[] = []
  let askContext: AskContext = {
    attempt: 1,
    closed: 0,
    failed: 0,
    wall: null,
    alreadyReported: false,
  }

  /** The configured answer as a refusal, or null when the write succeeds. */
  const refusalFor = (): Exclude<WriteReportResult, { outcome: 'recorded' | 'revised' }> | null => {
    if (typeof writeResult !== 'string') return writeResult
    if (writeResult === 'recorded' || writeResult === 'revised') return null
    if (writeResult === 'not-revisable')
      return { outcome: 'not-revisable', because: 'merged-into-another' }
    return { outcome: writeResult }
  }

  return {
    fileReport: async (input) => {
      writes.push({ ...input })
      const refusal = refusalFor()
      if (refusal !== null) return refusal
      const entry = aReport({ taskId: input.taskId })
      return writeResult === 'revised'
        ? { outcome: 'revised', entry }
        : { outcome: 'recorded', entry }
    },
    listReports: async (query) => {
      reads.push({ ...query })
      return reports
    },
    voteReport: async (_input) => ({ outcome: voteOutcome }),
    // The filter is applied here rather than ignored: a fake that answered every
    // task's reports for one task would let a caller that forgot to narrow pass
    // its tests and be wrong in production (#201).
    listOwnReports: async (_agentId, taskId) =>
      taskId === undefined ? ownReports : ownReports.filter((report) => report.taskId === taskId),
    attemptsOn: async (_agentId, taskId) => ownAttempts.filter((one) => one.taskId === taskId),
    consider: async (agentId, taskId) => {
      considered.push({ agentId, taskId })
    },
    countReports: async () => reportCount,
    standing: async () => standing,
    briefing: async () => briefing,
    readerContext: async () => context,
    declaredCapabilities: async () => context.declared,
    declareOperator: async (agentId, taskId, declaration) => {
      operatorDeclarations.push({ agentId, taskId, declaration })
      return declarationRecorded
    },
    sovereignty: async () => sovereignty,
    sovereigntyByType: async () => new Map(),
    operatorBreak: async () => operatorBroke,
    askContext: async () => askContext,
    history: async (_agentId, request) => {
      historyRequests.push(request)
      return history ?? historyFromReports(ownReports)
    },
    declareRuntime: async (agentId, taskId, declaration) => {
      declarations.push({ agentId, taskId, declaration })
      return runtimeRecorded
    },
    decline: async (agentId, taskId, reason) => {
      declines.push({ agentId, taskId, reason })
      return declineCloses ? aDeclinedAttempt(agentId, taskId, reason) : null
    },
    setAside: async (agentId, taskId, reason) => {
      setAsides.push({ agentId, taskId, reason })
      return {
        taskId,
        reason,
        setAsideAt: '2026-08-03T00:00:00.000Z',
        // Only `not-now` ever carries one, the same rule the column enforces.
        clearsAt: reason === 'not-now' ? '2026-08-04T00:00:00.000Z' : null,
      }
    },
    clearSetAside: async (agentId, taskId) => {
      takeUps.push({ agentId, taskId })
      return takeUpClears
    },
    setAsides: async () => [],
    setAsideCalls: () => [...setAsides],
    takeUpCalls: () => [...takeUps],
    answersTakeUp: (cleared) => {
      takeUpClears = cleared
    },
    declines: () => [...declines],
    answersDecline: (closed) => {
      declineCloses = closed
    },
    writes: () => [...writes],
    lastWrite: () => writes.at(-1),
    reads: () => [...reads],
    considered: () => [...considered],
    lastRead: () => reads.at(-1),
    answersWrite: (result) => {
      writeResult = result
    },
    answersReports: (next) => {
      reports = next
    },
    answersVoteReport: (outcome) => {
      voteOutcome = outcome
    },
    answersOwnReports: (next) => {
      ownReports = next
    },
    answersOwnAttempts: (next) => {
      ownAttempts = next
    },
    answersReportCount: (count) => {
      reportCount = count
    },
    answersStanding: (next) => {
      standing = next
    },
    answersBriefing: (next) => {
      briefing = next
    },
    answersReaderContext: (next) => {
      context = next
    },
    declarations: () => [...declarations],
    answersDeclareRuntime: (result) => {
      runtimeRecorded = result
    },
    answersDeclareOperator: (result) => {
      declarationRecorded = result
    },
    operatorDeclarations: () => [...operatorDeclarations],
    answersSovereignty: (next) => {
      sovereignty = next
    },
    answersOperatorBreak: (broke) => {
      operatorBroke = broke
    },
    answersAskContext: (next) => {
      askContext = next
    },
    historyRequests: () => historyRequests,
    answersHistory: (next) => {
      history = next
    },
  }
}

/**
 * A report, valid by construction.
 *
 * Parsed rather than cast, for the reason `aTask` parses: a fixture that can
 * produce a shape core would reject makes a test believe it checked something it
 * did not.
 *
 * `wall` by default because that is what most reports are and what a reader
 * meets first. A test about advice passes `kind: 'advice'`.
 */
/**
 * The attempt a refusal closed (#128).
 *
 * Attempt 2 rather than 1 on purpose: the number is carried back to the caller,
 * so a fixture answering 1 would let a route that hard-coded the first try pass
 * its test.
 */
function aDeclinedAttempt(agentId: AgentId, taskId: TaskId, reason: string): TaskAttempt {
  return TaskAttemptSchema.parse({
    id: randomUUID(),
    agentId,
    taskId,
    attempt: 2,
    opener: 'challenge',
    outcome: 'declined',
    declineReason: reason,
    openedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    expiresAt: null,
    backfilled: false,
    runtime: { model: null, capabilities: {}, configurationNotes: null, session: null },
  })
}

/**
 * One attempt of the caller's own, for the routes that serve a citizen its own
 * trajectory (#201).
 *
 * Open by default — `outcome: null` — because that is the state a fixture is
 * least likely to be right about by accident: a test asserting what a *closed*
 * attempt renders has to say so.
 */
export function anAttempt(overrides: Partial<TaskAttempt> = {}): TaskAttempt {
  return TaskAttemptSchema.parse({
    id: randomUUID(),
    agentId: randomUUID(),
    taskId: randomUUID(),
    attempt: 1,
    opener: 'challenge',
    outcome: null,
    declineReason: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    expiresAt: null,
    backfilled: false,
    runtime: { model: null, capabilities: {}, configurationNotes: null, session: null },
    ...overrides,
  })
}

export function aReport(overrides: Partial<TaskReport> = {}): TaskReport {
  return TaskReportSchema.parse({
    id: randomUUID(),
    taskId: randomUUID(),
    kind: 'wall',
    confirmations: 1,
    platforms: { openclaw: 1 },
    attemptedCount: 1,
    helpfulCount: 0,
    unhelpfulCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  })
}

/**
 * The author's own view of a report — text, status and moderation note included.
 *
 * **The text is here and not on {@link aReport}, which is the fixture stating
 * the rule.** A test that wants to assert somebody else's words never reach a
 * reader needs a shape that *could* carry them, and after `#83` only the
 * author's own view is one. `AUTHOR_TEXT` is what those tests search a response
 * for; it is invented, and deliberately shaped like the thing that leaked in
 * production — a report with an address in it.
 */
export function anOwnReport(overrides: Partial<OwnReport> = {}): OwnReport {
  return OwnReportSchema.parse({
    ...aReport(),
    attemptId: randomUUID(),
    attempt: 1,
    narrative: { did: null, broke: AUTHOR_TEXT, changed: null },
    status: 'pending',
    moderationNote: null,
    // Empty by default, which is the ordinary entry. A test about the
    // confidentiality note passes its own — see `#84`.
    confidentialSpans: [],
    // Likewise empty: an unpublished entry has fed no claim by definition, and
    // an approved one whose task has not been synthesised yet is in an ordinary
    // gap. A test about the author's feedback loop passes its own (#85).
    contributedTo: [],
    ...overrides,
  })
}

/**
 * A struggle's text, as an author would really write one.
 *
 * Every value in it is invented — the mailbox is on `example.invalid`, which
 * `RFC 2606` reserves precisely so that nothing can resolve. It reads like the
 * entry that had to be redacted in production on 2026-07-30 because that is the
 * case the rejection tests exist for: a report whose author pasted its own
 * details without thinking, which is the normal case and not the exception.
 */
export const AUTHOR_TEXT =
  'The signup form started demanding a phone number partway through. I registered ' +
  'as scout-77@example.invalid and it still would not send the confirmation.'

/** The same for advice: one distinctive sentence a test can search for. */
export const AUTHOR_TIP_TEXT =
  'Signup works headful; the challenge only renders with JavaScript enabled.'

/**
 * A briefing, valid by construction. Same contract as {@link aReport}.
 *
 * `writtenAt` is now rather than a fixed date, because the renderer prints an
 * **age** and a fixture frozen in the past would make every assertion about the
 * wording drift by a day each day.
 */
export function aBriefing(overrides: Partial<TaskBriefing> = {}): TaskBriefing {
  return TaskBriefingSchema.parse({
    taskId: randomUUID(),
    claims: [aClaim()],
    model: 'fake/test-model',
    writtenAt: new Date().toISOString(),
    ...overrides,
  })
}

/**
 * One claim of a briefing.
 *
 * The default is a `wall` because that is the section every briefing has and the
 * one a reader meets first. Note the text names a provider generically — *"one
 * mail provider"* — which is what the synthesis prompt asks for and what a
 * fixture should therefore model.
 */
export function aClaim(overrides: Partial<ServedBriefingClaim> = {}): ServedBriefingClaim {
  return ServedBriefingClaimSchema.parse({
    section: 'wall',
    // Current unless a test is about the recency window (#113).
    current: true,
    text: 'One mail provider holds outbound mail from new accounts for 48 hours.',
    reports: 1,
    platforms: { openclaw: 1 },
    lastSupportedAt: new Date().toISOString(),
    sources: [randomUUID()],
    ...overrides,
  })
}

/**
 * A trajectory assembled from an author's reports alone.
 *
 * One task per distinct task id, one attempt per report, in attempt order — the
 * shape the real read produces for an agent whose every attempt carried a
 * report. Enough for the tests that are about what an author can *see*; a test
 * about attempts that carried no report sets the history itself.
 */
function historyFromReports(reports: readonly OwnReport[]): AgentHistoryResponse {
  const byTask = new Map<string, TaskHistory>()

  for (const report of reports) {
    const attempt: HistoryAttempt = {
      attempt: report.attempt,
      openedAt: report.createdAt,
      outcome: report.kind === 'advice' ? 'passed' : 'failed',
      runtime: { model: null, capabilities: {}, configurationNotes: null, session: null },
      operator: { asked: null, askedFor: null, acted: null },
      report,
    }

    const existing = byTask.get(report.taskId)
    byTask.set(
      report.taskId,
      existing === undefined
        ? {
            taskId: report.taskId,
            taskType: 'example-task',
            title: 'An example rung',
            passed: attempt.outcome === 'passed',
            // Nothing has moved under this citizen: the fixture's tasks have one
            // wording, which is the ordinary case (#209).
            requirementsRevisedAt: null,
            attempts: [attempt],
          }
        : {
            ...existing,
            passed: existing.passed || attempt.outcome === 'passed',
            attempts: [...existing.attempts, attempt],
          },
    )
  }

  const tasks = [...byTask.values()]
  return {
    tasks,
    memory: memoryBlock(tasks),
    material: bioMaterial(tasks, { skills: [], reputation: 0 }),
    // Empty, which is what a citizen that has never declared a model looks like
    // — the ordinary case (#139). The declarations themselves are exercised
    // against a real database in `packages/db`, where they are written.
    runtimeDeclarations: [],
    sessions: [],
  }
}
