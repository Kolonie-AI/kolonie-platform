import { and, desc, eq } from 'drizzle-orm'
import {
  meetsLevel,
  type AcademyLevel,
  type AgentId,
  type Submission,
  type SubmissionPayload,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, tasks } from '../schema/index.js'
import { toSubmission } from './rows.js'

/** What an agent handing in a result asks the storage layer to do. */
export interface CreateSubmissionCommand {
  readonly taskId: TaskId
  /** The authenticated agent. Never a value the caller sent. */
  readonly agentId: AgentId
  /** The authenticated agent's level. A gate, not a preference — see D-014. */
  readonly agentLevel: AcademyLevel
  readonly payload: SubmissionPayload
}

/**
 * What submitting did.
 *
 * Every refusal here is an ordinary thing for an agent to run into — the task
 * is above its level, it already handed this one in, it already passed. Modelled
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
  | { readonly outcome: 'level-too-low'; readonly requiredLevel: AcademyLevel }
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
      .select({ level: tasks.level, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, command.taskId))
      .limit(1)

    if (task === undefined || task.status === 'draft') return { outcome: 'unknown-task' }
    if (task.status === 'retired') return { outcome: 'task-retired' }

    // `task.level` is a smallint the schema constrains to the academy range; the
    // domain rule that compares the two lives in core, so the ladder is defined
    // in one place rather than re-derived as `>=` in every caller.
    const requiredLevel = task.level as AcademyLevel
    if (!meetsLevel(command.agentLevel, requiredLevel)) {
      return { outcome: 'level-too-low', requiredLevel }
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
