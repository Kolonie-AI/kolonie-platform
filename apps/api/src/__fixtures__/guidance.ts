import { randomUUID } from 'node:crypto'
import {
  ServedBriefingClaimSchema,
  OwnReportSchema,
  TaskBriefingSchema,
  TaskReportSchema,
  type AgentId,
  type DeclareOperator,
  type DeclareRuntime,
  type Sovereignty,
  type ServedBriefingClaim,
  type OwnReport,
  type TaskId,
  type TaskBriefing,
  type TaskReport,
} from '@kolonie-ai/core'
import type {
  AttemptStanding,
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
  readonly answersDeclareRuntime: (recorded: boolean) => void
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
  let reportCount = 0
  let standing: AttemptStanding = { closed: 1, attempt: 2, passed: false }
  let briefing: TaskBriefing | undefined
  let context: ReaderContext = { divides: [], declared: null, movesMoney: false }
  const declarations: { agentId: AgentId; taskId: TaskId; declaration: DeclareRuntime }[] = []
  let declarationRecorded = true
  const operatorDeclarations: {
    agentId: AgentId
    taskId: TaskId
    declaration: DeclareOperator
  }[] = []
  let sovereignty: Sovereignty = { passes: 0, unattended: 0, share: null }
  let operatorBroke = false
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
    listOwnReports: async () => ownReports,
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
    declareRuntime: async (agentId, taskId, declaration) => {
      declarations.push({ agentId, taskId, declaration })
      return declarationRecorded
    },
    writes: () => [...writes],
    lastWrite: () => writes.at(-1),
    reads: () => [...reads],
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
    answersDeclareRuntime: (recorded) => {
      declarationRecorded = recorded
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
