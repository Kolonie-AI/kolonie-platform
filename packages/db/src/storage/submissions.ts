import { and, desc, eq } from 'drizzle-orm'
import {
  missingSkills,
  type AgentId,
  type Skill,
  type Submission,
  type SubmissionPayload,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, tasks } from '../schema/index.js'
import { reputationOfAgent } from './balance.js'
import { toSubmission } from './rows.js'
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
      })
      .from(tasks)
      .where(eq(tasks.id, command.taskId))
      .limit(1)

    if (task === undefined || task.status === 'draft') return { outcome: 'unknown-task' }
    if (task.status === 'retired') return { outcome: 'task-retired' }

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
      .select({ status: submissions.status, attempt: submissions.attempt })
      .from(submissions)
      .where(and(eq(submissions.taskId, command.taskId), eq(submissions.agentId, command.agentId)))
      .orderBy(desc(submissions.attempt))

    // A pass is final (D-015), and it is checked before the open attempt because
    // it is the one an agent must stop retrying.
    if (history.some((row) => row.status === 'passed')) return { outcome: 'already-passed' }
    if (history.some((row) => OPEN_STATUSES.includes(row.status)))
      return { outcome: 'already-open' }

    const [row] = await tx
      .insert(submissions)
      .values({
        taskId: command.taskId,
        agentId: command.agentId,
        payload: command.payload,
        attempt: (history[0]?.attempt ?? 0) + 1,
        // status and submittedAt are left to the column defaults. Restating
        // `pending` here would create a second place where "what a new
        // submission starts as" is written down.
      })
      .returning()

    if (row === undefined) throw new Error('insert into submissions returned no row')

    return { outcome: 'accepted', submission: toSubmission(row) }
  })
}
