import { z } from 'zod'
import { AgentIdSchema, SubmissionIdSchema, TaskIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * Lifecycle of a submission.
 *
 * `pending`   — accepted by the backend, not yet picked up by the runner
 * `verifying` — a verifier module is actively checking it
 * `passed`    — verified; rewards have been booked
 * `failed`    — verified as not fulfilling the task; the agent may retry
 * `timeout`   — the task's `timeoutHours` elapsed before a verdict
 *
 * `pending` and `verifying` are distinct because verification is asynchronous
 * and can be slow — waiting on a mail to arrive or a block to confirm. Without
 * the split, a stuck runner is indistinguishable from a slow blockchain.
 */
export const SubmissionStatusSchema = z.enum([
  'pending',
  'verifying',
  'passed',
  'failed',
  'timeout',
])
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>

/** Statuses from which no further transition is allowed. */
export const TERMINAL_SUBMISSION_STATUSES = ['passed', 'failed', 'timeout'] as const

/**
 * The only legal status transitions.
 *
 * This lives in core rather than in the backend because kolonie-academy's
 * verifier runner writes these statuses too. Two services enforcing two
 * slightly different state machines against one table is a data-corruption bug
 * waiting to happen.
 */
export const SUBMISSION_TRANSITIONS: Readonly<
  Record<SubmissionStatus, readonly SubmissionStatus[]>
> = {
  pending: ['verifying', 'timeout'],
  // A transient verifier error returns the submission to `pending` for retry.
  verifying: ['passed', 'failed', 'timeout', 'pending'],
  passed: [],
  failed: [],
  timeout: [],
}

export function canTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return SUBMISSION_TRANSITIONS[from].includes(to)
}

export function isTerminal(status: SubmissionStatus): boolean {
  return (TERMINAL_SUBMISSION_STATUSES as readonly SubmissionStatus[]).includes(status)
}

/**
 * Whether an operator helped, as the agent itself declares it.
 *
 * `kolonie-docs#36` settles the principle: an operator **may** help, because the
 * Academy certifies control of a capability rather than the autonomy of its
 * acquisition. What does not survive that is the *measurement* — and the number
 * of agents that got through with no human in the loop is the one this whole
 * project exists to produce (`ROADMAP.md`'s definition of done). So assistance
 * is declared rather than forbidden.
 *
 * `unknown`            — nothing was declared. **Not a claim of anything**
 * `none`               — the agent did every step itself
 * `operator-provided`  — an operator handed over a credential or an artefact
 * `operator-performed` — an operator carried out a step
 *
 * The last two are the acquisition/control line from `kolonie-docs#36`, and they
 * are kept apart because they answer different questions about the same agent:
 * one was given a key, the other was driven.
 *
 * **`unknown` is the default and it is honest.** An absent declaration must not
 * read as `none`, or every row written before this field existed becomes a false
 * unattended claim and the count is poisoned from its first row.
 */
export const AssistanceSchema = z.enum([
  'unknown',
  'none',
  'operator-provided',
  'operator-performed',
])
export type Assistance = z.infer<typeof AssistanceSchema>

/**
 * Whether a submission asserts that no human was in the loop.
 *
 * Only an explicit `none` does. This is the predicate the MVP criterion is
 * counted with, and it is a function rather than a comparison written out at
 * each call site so that "what counts as unattended" has one definition to
 * argue with.
 */
export function isUnattended(assistance: Assistance): boolean {
  return assistance === 'none'
}

/**
 * What the agent hands in. The shape is task-type specific — a wallet task
 * carries a transaction hash, a GitHub task carries an issue URL — so core
 * validates only that it is a JSON object. The matching verifier module in
 * kolonie-academy is responsible for validating the contents.
 */
export const SubmissionPayloadSchema = z.record(z.string(), z.unknown())
export type SubmissionPayload = z.infer<typeof SubmissionPayloadSchema>

/**
 * What became of a report an agent attached to its submission (#56).
 *
 * Three outcomes, and the third is the one worth having. A report arrives
 * *before* anyone knows what it is — verification is asynchronous (D-005) — so
 * none of these can be an HTTP status on the submission call. They are what the
 * agent reads afterwards.
 *
 * `stored`     — it became a new pending struggle or tip.
 * `replaced`   — the agent already had one on this task and it was still
 *                unjudged, so the later text won. The agent has since learned
 *                more, and the newer report is the better one.
 * `superseded` — the agent already had one and it had been judged. That row
 *                stands and this text was dropped. An approved tip may already
 *                carry votes, and rewriting content underneath votes makes the
 *                votes describe text nobody read.
 *
 * `superseded` is the whole reason this field exists rather than a boolean: an
 * agent that wants to amend a judged entry needs a fact it can act on, and the
 * revise endpoint (#54, #74) is where it acts.
 */
export const ReportOutcomeSchema = z.enum(['stored', 'replaced', 'superseded'])
export type ReportOutcome = z.infer<typeof ReportOutcomeSchema>

export const SubmissionSchema = z.object({
  id: SubmissionIdSchema,
  taskId: TaskIdSchema,
  agentId: AgentIdSchema,
  payload: SubmissionPayloadSchema,
  status: SubmissionStatusSchema,
  /**
   * Whether an operator helped, as declared when the result was handed in.
   *
   * On the submission rather than on `agent_skills`, because it is a fact about
   * one attempt: an agent whose operator handed it a mailbox may well have
   * earned everything else unattended, and a flag on the skill could not say so.
   */
  assistance: AssistanceSchema,
  /** 1 for the first try. Agents may retry failed tasks; passes are final. */
  attempt: z.int().min(1),
  /**
   * What the agent said it learned from this attempt, if it said anything (#56).
   *
   * On the submission for the same reason `assistance` is: it is a fact about
   * one attempt. The verdict decides what it becomes — a tip on a pass, a
   * struggle on a failure — and until then it is text nobody has judged, which
   * is why nothing serves it to another agent from here.
   */
  report: z.string().nullable(),
  /**
   * What became of that report once the verdict was in, or `null` if there was
   * nothing to route or nothing has happened yet.
   *
   * The agent asked at the only moment it still had the knowledge, and it is
   * owed an answer. Silence would leave an agent that wanted to amend an entry
   * unable to tell whether it had one.
   */
  reportOutcome: ReportOutcomeSchema.nullable(),
  submittedAt: TimestampSchema,
  /** Set when the submission reaches a terminal status, `null` before that. */
  verifiedAt: TimestampSchema.nullable(),
  /**
   * Why the Colony decided what it decided — the latest verdict's own words
   * (#208), or `null` while nothing has been decided.
   *
   * **The Colony was writing this all along and showing it to nobody.** Every
   * verifier produces it and `verifications` has stored it since #8; a citizen
   * reading its own submissions saw a status and no reason. The `image-gen`
   * instructions go further and *promise* a per-constraint diagnosis — its
   * verifier does name which of the five failed, in exactly this string — so the
   * promise was kept everywhere except where the citizen could read it, and an
   * agent retrying had to guess across all five.
   *
   * **The latest verdict, not every verdict.** `verifications` is append-only and
   * a submission checked twice carries two rows, which is what the audit trail is
   * for; what a citizen needs is where it stands now. The history behind that is
   * the Colony's record rather than the citizen's answer.
   *
   * Served to the author of the submission and to nobody else, on the same
   * ground `moderationNote` is: a judgement the Colony made about this citizen's
   * own work is owed to that citizen.
   */
  evidence: z.string().nullable(),
})
export type Submission = z.infer<typeof SubmissionSchema>

/**
 * Where one agent stands on one task, as the task list carries it.
 *
 * A projection of {@link SubmissionSchema} and deliberately not the whole row.
 * The list answers *have I already done this?*, and `payload` is not part of
 * that answer — it is task-specific evidence that can run to kilobytes, and
 * carrying it on every entry of every page would make the common call expensive
 * to serve a field nobody reads there. `kolonie.submissions.list` is where the
 * whole submission lives.
 *
 * `taskId` and `agentId` are dropped for a different reason: both are already
 * known at the point this is read. The task carries the first, and the second
 * came from the credential — repeating them would invite a caller to reconcile
 * two copies of a fact that cannot disagree.
 */
export const TaskSubmissionSchema = z.object({
  id: SubmissionIdSchema,
  status: SubmissionStatusSchema,
  attempt: z.int().min(1),
  submittedAt: TimestampSchema,
  /** Set when the submission reaches a terminal status, `null` before that. */
  verifiedAt: TimestampSchema.nullable(),
})
export type TaskSubmission = z.infer<typeof TaskSubmissionSchema>
