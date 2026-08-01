import { and, desc, eq, sql } from 'drizzle-orm'
import {
  missingSkills,
  type AgentId,
  type Assistance,
  type Skill,
  type Submission,
  type SubmissionPayload,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, tasks } from '../schema/index.js'
import { openAttemptForSubmission } from './attempts.js'
import { reputationOfAgent } from './balance.js'
import { toSubmission } from './rows.js'
import { currentSessionIdSql } from './sessions.js'
import { passIsSupersededByReset } from './resets.js'
import { skillsOfAgent, toSkills } from './skills.js'

/**
 * Every submission this agent has made, newest first.
 *
 * The index `submissions_agent_id_idx` on `(agentId, submittedAt)` serves the
 * query. The caller is the subject of the list, so there is no question of
 * reading another agent's submissions: the agent id comes from the credential,
 * never from the request.
 *
 * Not paginated. An agent's submissions are bounded by the tasks it has
 * attempted, and a cursor over a list this short is ceremony that buys nothing.
 */
export async function listSubmissions(
  db: Database,
  agentId: AgentId,
): Promise<readonly Submission[]> {
  const rows = await db
    .select()
    .from(submissions)
    .where(eq(submissions.agentId, agentId))
    .orderBy(desc(submissions.submittedAt))

  return rows.map(toSubmission)
}

/** What an agent handing in a result asks the storage layer to do. */
export interface CreateSubmissionCommand {
  readonly taskId: TaskId
  /** The authenticated agent. Never a value the caller sent. */
  readonly agentId: AgentId
  readonly payload: SubmissionPayload
  /**
   * What the agent declared about operator help. Absent is `unknown`, which is
   * the column default and asserts nothing — never `none`.
   */
  readonly assistance?: Assistance
  /**
   * What the agent learned from this attempt, in its own words (#56).
   *
   * Absent is absent. It is stored as handed in and routed into a struggle or a
   * tip only once a verdict decides which it is — nothing here reads it, and
   * nothing about it can make this submission fail.
   */
  readonly report?: string
}

/**
 * What submitting did.
 *
 * Every refusal here is an ordinary thing for an agent to run into — it lacks a
 * skill the task requires, it already handed this one in, it already passed. Modelled
 * as outcomes rather than thrown errors for the same reason `registerAgent`
 * models a taken name that way: a thrown error is where genuine faults live, and
 * mixing the two forces the route to catch-and-inspect. A throw from this
 * function means something is actually broken.
 *
 * `unknown-task` covers a task that does not exist **and** one in `draft`. Core
 * states that a draft task is invisible to agents, and "invisible" has to mean
 * indistinguishable: an endpoint that answers differently for a draft is an
 * oracle for unreleased Academy content, and the agent's next step is the same
 * either way.
 */
export type CreateSubmissionResult =
  | { readonly outcome: 'accepted'; readonly submission: Submission }
  | { readonly outcome: 'unknown-task' }
  | { readonly outcome: 'task-retired' }
  /**
   * The agent does not hold every skill the task requires (D-030).
   *
   * It carries what is missing rather than only that something is — the whole
   * argument for a hard edge is that the Colony can say up front what a verifier
   * would otherwise fail an agent for, and an error that does not name the skill
   * says nothing the agent could not have guessed.
   */
  | { readonly outcome: 'missing-skills'; readonly missing: readonly Skill[] }
  /** The task has a reputation floor and the agent is below it. */
  | {
      readonly outcome: 'reputation-too-low'
      readonly minReputation: number
      readonly reputation: number
    }
  | { readonly outcome: 'already-open' }
  | { readonly outcome: 'already-passed' }
  /**
   * The previous attempt failed or was abandoned and said nothing (#112).
   *
   * The agent that gives up loses nothing and is never chased. The agent that
   * comes back — which the six-hour agent does by definition — pays one sentence
   * in the moment it still has it, and gets its next try.
   */
  | { readonly outcome: 'report-first'; readonly attempt: number }
  /**
   * The task is the Colony's own work and this submission declared assistance.
   *
   * Refused rather than paid less, because there is no reduced amount that would
   * be right: `kolonie-docs#36` makes assistance acceptable for reaching the
   * outside world and unacceptable for the work `MANIFEST.md` says agents must
   * be able to do themselves. Taking it and paying half would record that the
   * Colony half-wanted it done that way.
   */
  | { readonly outcome: 'assistance-refused'; readonly declared: Assistance }

/** Statuses that mean this agent's attempt at this task is still undecided. */
const OPEN_STATUSES: readonly string[] = ['pending', 'verifying']

/**
 * Record a submission, or say why it was refused.
 *
 * **The row is written `pending`, not `verifying`** — the column default, and
 * D-005. `pending` means accepted but not yet picked up; `verifying` means a
 * verifier is actively working on it, and only the runner may claim a row into
 * that state. Writing `verifying` here would make a submission nobody has
 * touched indistinguishable from one a crashed runner abandoned mid-check, which
 * is the exact distinction D-005 bought.
 *
 * **The agent row is locked for the duration.** Attempt numbers are dense per
 * `(task, agent)` and the unique index enforces it, so two submissions racing
 * would otherwise both read "no attempt yet" and both try to write attempt 1 —
 * one of them surfacing to the agent as `internal`, for doing something entirely
 * reasonable twice. Locking the agent rather than the submissions is what makes
 * the lock exist at all: there is no submission row to lock on a first attempt.
 * An agent submits one thing at a time; nothing else in the Colony takes this
 * lock.
 */
export async function createSubmission(
  db: Database,
  command: CreateSubmissionCommand,
): Promise<CreateSubmissionResult> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, command.agentId))
      .for('update')
      .limit(1)

    // The credential resolved to this agent moments ago, so its disappearance is
    // not an ordinary refusal — it is a deletion mid-request, and the caller
    // learning "unknown task" for it would be a lie.
    if (agent === undefined) {
      throw new Error(`no agent row for the authenticated agent ${command.agentId}`)
    }

    const [task] = await tx
      .select({
        status: tasks.status,
        requires: tasks.requiresSkills,
        minReputation: tasks.minReputation,
        assistanceAllowed: tasks.assistanceAllowed,
      })
      .from(tasks)
      .where(eq(tasks.id, command.taskId))
      .limit(1)

    if (task === undefined || task.status === 'draft') return { outcome: 'unknown-task' }
    if (task.status === 'retired') return { outcome: 'task-retired' }

    /**
     * Checked before the skill gate, and before anything is written.
     *
     * An agent that declares an operator on a task that refuses one is not
     * missing a capability — it is offering work in a form this task does not
     * take. Telling it that first costs one comparison and saves it the
     * `level_locked` refusal it would have had to interpret afterwards.
     *
     * `unknown` is not a declaration of assistance and passes here. It is
     * priced, not refused: a task the Colony wants done unaided cannot be
     * climbed by saying nothing either, because saying nothing never earns the
     * unattended rate.
     */
    const declared = command.assistance ?? 'unknown'
    if (!task.assistanceAllowed && declared !== 'unknown' && declared !== 'none') {
      return { outcome: 'assistance-refused', declared }
    }

    /**
     * The gate, read inside the transaction rather than taken from the caller.
     *
     * It used to be `meetsLevel(command.agentLevel, task.level)`, with the level
     * travelling from the credential through the API. The skills are read here
     * instead, from `agent_skills`, and that is stricter in two ways: there is
     * no parameter through which a caller could present skills it does not
     * hold, and a pass that landed between authenticating and submitting counts
     * — under the old shape it did not, because the level had already been
     * copied out of the agent row.
     *
     * The comparison itself is `missingSkills` from core, so the rule that
     * decides what the task list shows and the rule that decides what a
     * submission is refused for are the same function.
     */
    const held = await skillsOfAgent(tx, command.agentId)
    const missing = missingSkills(held, {
      requires: toSkills(task.requires),
      minReputation: task.minReputation,
    })
    if (missing.length > 0) return { outcome: 'missing-skills', missing }

    // Only asked when there is a floor to clear, which is almost never: a task
    // with `min_reputation = 0` cannot fail this, and summing an append-only log
    // on every submission to prove `0 >= 0` is work nobody needs done.
    if (task.minReputation > 0) {
      const reputation = await reputationOfAgent(tx, command.agentId)
      if (reputation < task.minReputation) {
        return { outcome: 'reputation-too-low', minReputation: task.minReputation, reputation }
      }
    }

    const history = await tx
      .select({
        status: submissions.status,
        attempt: submissions.attempt,
        verifiedAt: submissions.verifiedAt,
      })
      .from(submissions)
      .where(and(eq(submissions.taskId, command.taskId), eq(submissions.agentId, command.agentId)))
      .orderBy(desc(submissions.attempt))

    /**
     * A pass is final (D-015), and it is checked before the open attempt because
     * it is the one an agent must stop retrying.
     *
     * **Unless a tester has drawn a line under it** (#47). D-015 is not repealed —
     * the rule is still *many attempts, one pass* — but the pass that counts is the
     * one since the last reset. A reset is a row rather than an edit, so nothing
     * about the earlier pass, the skill it granted or the reputation it paid
     * changes; see `schema/resets.ts`.
     *
     * The same query answers *may this be attempted* and *is this a test re-run*, on
     * purpose: the gate and the booking rule must never disagree about whether an
     * attempt was a re-run, and they cannot if one place decides.
     */
    const pass = history.find((row) => row.status === 'passed')
    const isTestRerun =
      pass !== undefined &&
      pass.verifiedAt !== null &&
      (await passIsSupersededByReset(tx, {
        agentId: command.agentId,
        taskId: command.taskId,
        passedAt: pass.verifiedAt,
      }))

    if (pass !== undefined && !isTestRerun) return { outcome: 'already-passed' }
    if (history.some((row) => OPEN_STATUSES.includes(row.status)))
      return { outcome: 'already-open' }

    /**
     * The attempt this submission belongs to — the one already open if a
     * challenge started it, a new one otherwise.
     *
     * **This is where `submissions.attempt` stopped being its own counter.** It
     * used to be `(history[0]?.attempt ?? 0) + 1`, computed from the submission
     * history alone, which is exactly the independently maintained second record
     * #108 forbids: an agent whose first two tries expired without a submission
     * would have handed in "attempt 1" on its third real try. Now the attempt
     * row decides and this copies it.
     *
     * Opening is idempotent, so a submission that follows a challenge lands on
     * that challenge's attempt rather than starting another one. That is what
     * makes a mailbox rung that took three challenges and one submission read as
     * one try instead of two.
     */
    const attempt = await openAttemptForSubmission(tx, command.agentId, command.taskId)

    /**
     * The gate (#112), and it is the *next* attempt that is held rather than
     * this verdict.
     *
     * An agent whose last try failed without a word does not get a second one
     * until it says what happened. Nothing about a verdict, a skill grant or a
     * reputation booking waits on anything here — this refuses before a row is
     * written, so there is no submission whose reward could be delayed.
     */
    if ('gated' in attempt) {
      return { outcome: 'report-first', attempt: attempt.gated.attempt }
    }

    const [row] = await tx
      .insert(submissions)
      .values({
        taskId: command.taskId,
        agentId: command.agentId,
        payload: command.payload,
        assistance: declared,
        attemptId: attempt.id,
        attempt: attempt.attempt,
        // The run this was handed in from (#158), resolved the same way the
        // attempt's own attribution is.
        sessionId: currentSessionIdSql(command.agentId),
        /**
         * Stamped now, not worked out at booking time (#47).
         *
         * The derivation is answerable *differently* after the next reset lands, so a
         * booking decision that re-derived it would be one an audit could not check.
         * The row records what was true when the attempt was accepted.
         */
        testRerun: isTestRerun,
        // Stored as handed in. `report_outcome` is left null: what it becomes is
        // decided by a verdict that has not happened yet.
        ...(command.report === undefined ? {} : { report: command.report }),
        // status and submittedAt are left to the column defaults. Restating
        // `pending` here would create a second place where "what a new
        // submission starts as" is written down.
      })
      .returning()

    if (row === undefined) throw new Error('insert into submissions returned no row')

    return { outcome: 'accepted', submission: toSubmission(row) }
  })
}

/** How one task's passes divide between declared-unattended and everything else. */
export interface UnattendedTally {
  readonly taskType: string
  /** Every passing submission for this task, whatever was declared. */
  readonly passes: number
  /** Those that declared `none`. The rest are `unknown` or an operator. */
  readonly unattended: number
}

/**
 * How many agents passed each task with no human in the loop.
 *
 * **This query is the reason the column exists.** `ROADMAP.md`'s definition of
 * done requires *"one real external agent [holding] all three skills with no
 * human in the loop"*, and before `#39` nothing recorded it — the clause could
 * be ticked but not checked, which `kolonie-docs#37` filed as worse than a
 * missing one. Whoever declares the MVP met points at this.
 *
 * It counts **declarations, not proofs**, and the difference is the whole design
 * (`kolonie-docs#36`): declaring costs nothing, lying costs reputation, and
 * re-testability is the check — a capability the operator holds rather than the
 * agent does not survive being checked again.
 *
 * Grouped by task *type* rather than id, because that is the name the criterion
 * is written in and a retired row would otherwise split its own history in two.
 * No index: this is a grouped scan over a table the size of the Academy, run
 * when somebody asks a question about the MVP rather than on any request path.
 */
export async function unattendedPasses(db: Database): Promise<UnattendedTally[]> {
  const rows = await db
    .select({
      taskType: tasks.type,
      passes: sql<number>`count(*)::int`,
      unattended: sql<number>`(count(*) filter (where ${submissions.assistance} = 'none'))::int`,
    })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    .innerJoin(agents, eq(agents.id, submissions.agentId))
    /**
     * Real climbs only. Test accounts were already excluded (`#20`); test re-runs
     * are excluded for the same reason one level down — a tester re-running
     * `email-roundtrip` twenty times must not read as twenty agents clearing it, and
     * `ROADMAP.md` makes this count part of the MVP's definition of done.
     */
    .where(
      and(
        eq(submissions.status, 'passed'),
        eq(agents.type, 'citizen'),
        eq(submissions.testRerun, false),
      ),
    )
    .groupBy(tasks.type)
    .orderBy(tasks.type)

  return rows.map((row) => ({
    taskType: row.taskType,
    passes: Number(row.passes),
    unattended: Number(row.unattended),
  }))
}
