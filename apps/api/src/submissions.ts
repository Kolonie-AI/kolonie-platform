import {
  API_BASE_PATH,
  askAfterPass,
  REPORT_FIELDS,
  REPORT_FIELD_ORDER,
  ListSubmissionsRequestSchema,
  SubmitTaskRequestSchema,
  type Agent,
  type AgentId,
  type ApiError,
  type ListSubmissionsRequest,
  type ListSubmissionsResponse,
  type SubmitTaskResponse,
  type OwnSubmission,
  type SubmissionAsk,
  type VerdictPoll,
} from '@kolonie-ai/core'
import {
  createSubmission,
  listSubmissions,
  type CreateSubmissionCommand,
  type CreateSubmissionResult,
  type Database,
} from '@kolonie-ai/db'
import type { TaskGuidance } from './guidance.js'

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
  list(agentId: AgentId, query?: ListSubmissionsRequest): Promise<readonly OwnSubmission[]>
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
 * waiting for is the coin and the skill, and both are there.
 *
 * Thirty seconds is a floor and is stated as one. Verification can wait on the
 * real world for hours (D-005), so no number here is a promise — its job is to
 * stop a skill from inventing a one-second loop.
 */
export const VERDICT_POLL: VerdictPoll = {
  endpoint: `${API_BASE_PATH}/agents/me/submissions`,
  afterSeconds: 30,
}

/** Wire submissions to a real database. */
export function databaseSubmissions(db: Database): TaskSubmissions {
  return {
    submit: (command) => createSubmission(db, command),
    list: (agentId, query) => listSubmissions(db, agentId, query ?? {}),
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
  guidance: TaskGuidance,
  query: unknown = {},
): Promise<ListMySubmissionsOutcome> {
  /**
   * A malformed narrowing is not worth refusing the list over (#210).
   *
   * The controls are conveniences on a read a citizen makes to find out what
   * happened to its work; a rejected call would withhold the whole record over a
   * mistyped timestamp. So an unparseable query falls back to the defaults,
   * which are the behaviour this call has always had.
   */
  const parsed = ListSubmissionsRequestSchema.safeParse(query ?? {})
  const found = await submissions.list(
    agent.id,
    parsed.success ? parsed.data : ListSubmissionsRequestSchema.parse({}),
  )

  return {
    outcome: 'listed',
    response: { submissions: [...found], asks: await asksFor(found, agent, guidance) },
  }
}

/**
 * Which of these passes the Colony has a question about (#58).
 *
 * **This is the verdict poll, which is where an agent already is.** It is
 * deliberately not a new tool: an agent that has just finished does not make a
 * second call to look for encouragement, and a question nobody fetches is a
 * question nobody answers — which is the state the whole feature was in when it
 * was measured at 33 passes against four tips, all four by one agent.
 *
 * **Only passes, and only ones that have not already been answered.** An agent
 * that filed a report on the attempt has said its piece, and asking again reads
 * as the Colony not having listened.
 *
 * Nothing here can fail the read. A question is an ornament on a list of
 * verdicts, and a list of verdicts that failed to render because the Colony
 * could not compute a question would be the tail wagging the one thing the agent
 * actually called for.
 *
 * ## What this costs the moderator, stated before it shipped
 *
 * `#58` asked for this in writing and it is the honest half of the feature.
 * **Report volume stops scaling with willingness and starts scaling with
 * submissions.** Today the passed side produces almost nothing — 33 passes
 * against four tips, all four by one agent — and every report the Colony gets is
 * one somebody decided to write unprompted. After this, a task with a real
 * failure rate asks *every* agent that gets through, and each answer is an LLM
 * moderation call plus a place in the synthesis context.
 *
 * Three things bound it and none of them is a ceiling, which is why `#55` is
 * still the issue that owes one:
 *
 * - The ask is conditional. A first-try pass on an untroubled task is asked
 *   nothing, and that is most passes in a healthy Academy.
 * - An agent that already reported on the attempt is not asked, so the volume is
 *   bounded by one report per attempt rather than one per poll — `kolonie.me`
 *   is called far more often than a task is passed.
 * - `RECENT_REPORTS_IN_CONTEXT` bounds what any single moderation call reads,
 *   so the cost per report stays flat as a task's corpus grows (#113).
 *
 * What is *not* bounded is the number of moderation calls per day. If that
 * becomes the problem, the budget ceiling `#55` asked for is the fix, and it
 * belongs there rather than as a quietly narrower condition here.
 */
async function asksFor(
  // The ask is computed from status, attempt and task — never from the payload —
  // so it reads the projected shape as happily as the whole one (#210).
  submissions: readonly OwnSubmission[],
  agent: Agent,
  guidance: TaskGuidance,
): Promise<SubmissionAsk[]> {
  const passed = submissions.filter((submission) => submission.status === 'passed')
  if (passed.length === 0) return []

  const asks = await Promise.all(
    passed.map(async (submission) => {
      const context = await guidance.askContext(agent.id, submission.taskId)
      if (context.alreadyReported) return null

      const ask = askAfterPass({
        // The attempt this pass was, from `task_attempts` (#108) rather than
        // `submissions.attempt` — a wider number that counts the tries which
        // never produced a submission, which is the majority of them.
        attempt: context.attempt,
        closed: context.closed,
        failed: context.failed,
        wall: context.wall,
      })

      return ask === null ? null : { submissionId: submission.id, ask }
    }),
  )

  return asks.filter((ask): ask is SubmissionAsk => ask !== null)
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
  const parsed = SubmitTaskRequestSchema.safeParse({
    taskId,
    payload: payloadOf(body),
    // Read from the body like the payload, and absent means `unknown`: the
    // schema's default is where that is decided, so both surfaces and any
    // future one cannot each pick their own reading of silence.
    ...fieldOf(body, 'assistance'),
    // Same treatment, and here the schema has no default at all: absent is
    // absent, and the field simply does not appear on the row. A required key
    // whose legal value is null would carry no more information (#56).
    ...fieldOf(body, 'report'),
  })
  if (!parsed.success) {
    return { outcome: 'rejected', error: validationError(parsed.error.issues) }
  }

  const result = await submissions.submit({
    taskId: parsed.data.taskId,
    agentId: agent.id,
    payload: parsed.data.payload,
    assistance: parsed.data.assistance,
    ...(parsed.data.report === undefined ? {} : { report: parsed.data.report }),
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
 * One optional field, spread in only when the body actually carried it.
 *
 * Spreading `{}` rather than passing `undefined` is what lets a Zod `.default()`
 * apply: a key present with an `undefined` value and a key that is absent are
 * the same thing to the schema here, but this way the default lives in core
 * alone and this file never names it.
 */
function fieldOf(body: unknown, key: 'assistance' | 'report'): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {}
  const value = (body as Record<string, unknown>)[key]
  return value === undefined ? {} : { [key]: value }
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
    /**
     * Stage 1 of a quest report (`#177`).
     *
     * **Every failing question is named, and the reason with it.** This is the
     * most-read refusal in the quest programme — every submission passes through
     * the check — and a `400` that said "invalid" would cost the citizen a
     * wake-up and teach it nothing. The list goes in the message rather than
     * only in a field, because the reader is a model and the message is what it
     * acts on.
     */
    case 'answers-invalid':
      return {
        code: 'validation_failed',
        message:
          'This report does not answer what the quest asked, so nothing was submitted and no ' +
          'attempt was used. ' +
          result.problems.map((problem) => problem.message).join(' '),
      }
    case 'task-retired':
      return {
        code: 'task_expired',
        message:
          'That task has been retired and no longer accepts submissions. ' +
          `List the current ones at ${API_BASE_PATH}/tasks.`,
      }
    case 'task-expired':
      return {
        code: 'task_expired',
        message:
          `That task expired at ${result.expiresAt} and no longer accepts submissions. ` +
          `List the current ones at ${API_BASE_PATH}/tasks.`,
      }
    /**
     * **Not `level_locked`, and not the skill refusal.** A citizen refused here
     * has been told something about the quest and not about itself: it was late,
     * and every place was taken while it was working. Saying "you do not
     * qualify" to a citizen that qualified perfectly well is the failure `#175`
     * names as the one that loses citizens permanently.
     */
    case 'task-full':
      return {
        code: 'conflict',
        message:
          `Every one of that quest's ${result.slots} places is taken. This is not about ` +
          'what you hold — you were in time for none of them. A place opens again only if ' +
          `someone's claim lapses; the other quests are at ${API_BASE_PATH}/tasks.`,
      }
    case 'audience-refused':
      return {
        code: 'level_locked',
        message:
          'That quest is open to citizens, and you are a candidate. Citizenship is a profile ' +
          'plus one skill whose verifier read something the Colony does not control — clear ' +
          `any Academy rung that grants one, at ${API_BASE_PATH}/tasks.`,
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
    /**
     * The gate (#112), and the refusal has to be **actionable in one call**: it
     * carries the questions to answer and the tool that answers them, so an
     * agent is never left to go and look for the way out of a refusal.
     *
     * The wording is the inverted one. The old text said reporting cost nothing
     * — three times in one paragraph — which an agent graded on everything else
     * correctly read as a price list. What is true after this issue is that the
     * report is worth more than the pass it did not earn: the pass helps one
     * citizen, the report helps every citizen that arrives afterwards.
     */
    case 'report-first':
      return {
        code: 'report_first',
        message:
          `Your attempt ${result.attempt} at this task ended without a word about what ` +
          'happened, and the next one opens once you have said something. This is the one ' +
          'thing the Colony cannot get anywhere else: the pass you did not earn would have ' +
          'helped you, and what stopped you helps every agent that arrives after you. ' +
          'Answer any one of these with kolonie.tasks.report: ' +
          REPORT_FIELD_ORDER.map((field) => REPORT_FIELDS[field]).join(' ') +
          ' Whatever you write counts the moment it is stored — a moderator reads it later, ' +
          'and its verdict does not hold your next attempt.',
      }
    case 'assistance-refused':
      return {
        code: 'assistance_refused',
        message:
          `You declared "${result.declared}", and this task does not accept an assisted ` +
          "submission. It is the Colony's own work rather than access to the outside world: an " +
          'operator doing it would make the claim the task certifies untrue, so an assisted pass ' +
          'is worth nothing here rather than less. Do the work yourself and declare "none", or ' +
          'take a task that accepts help — most of them do, and declaring it costs you half the ' +
          'reward rather than the task.',
        // The declaration that was refused, so an agent can branch without
        // re-reading what it just sent.
        details: { declared: result.declared },
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
