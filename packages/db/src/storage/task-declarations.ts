import { and, eq, sql } from 'drizzle-orm'
import type { AgentId, DeclareOperator, DeclareRuntime, TaskId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { taskDeclarations } from '../schema/task-declarations.js'
import { tasks } from '../schema/tasks.js'

/**
 * Where a declaration goes when the citizen never got an attempt open
 * (`#479`, `#481`).
 *
 * The reasoning for the table is on {@link taskDeclarations}; this is the write
 * path and the two rules that are properties of the *call* rather than of the
 * storage.
 *
 * **Merge, never replace.** Absent fields are left as they were, which is the
 * rule `declareRuntime` already follows against an attempt. A citizen that says
 * its model on one call and its route on the next has said both, and a partial
 * declaration that silently erased an earlier one would make saying what you
 * know when you know it the lossy option.
 *
 * **The row is the citizen's current description of one rung**, so a second
 * declaration corrects the first rather than joining it. That is why this is an
 * upsert on `(agent_id, task_id)` and not an append: the question it answers is
 * *what is this citizen running as*, in the present tense, and a history of that
 * is what `task_attempts` is for once there is one.
 */

/** Whether the task exists at all — the one thing the FK would otherwise answer with a crash. */
export async function taskExists(db: Database | Transaction, taskId: TaskId): Promise<boolean> {
  const [row] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
  return row !== undefined
}

/**
 * Record what a citizen is running as, against the task rather than an attempt.
 *
 * Called only when no attempt exists to take it. Nothing here can fail an
 * attempt, delay a verdict or reduce a reward — there is no attempt for it to
 * touch, which makes D-032's guarantee trivially true on this path rather than
 * merely upheld.
 */
export async function declareRuntimeOnTask(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
  declaration: DeclareRuntime,
): Promise<void> {
  const set = {
    ...(declaration.model === undefined ? {} : { model: declaration.model }),
    ...(declaration.configurationNotes === undefined
      ? {}
      : { configurationNotes: declaration.configurationNotes }),
    ...(declaration.session === undefined ? {} : { session: declaration.session }),
    ...(declaration.inboundRoute === undefined ? {} : { inboundRoute: declaration.inboundRoute }),
  }

  await db
    .insert(taskDeclarations)
    .values({
      agentId,
      taskId,
      capabilities: declaration.capabilities ?? {},
      ...set,
    })
    .onConflictDoUpdate({
      target: [taskDeclarations.agentId, taskDeclarations.taskId],
      set: {
        ...set,
        /**
         * Merged in SQL rather than read-then-written, so two declarations
         * arriving together cannot lose one of the flags. `||` on `jsonb` is a
         * right-biased merge, which is the same precedence the attempt path
         * applies in JavaScript: what arrived now wins over what was there.
         */
        capabilities: sql`${taskDeclarations.capabilities} || ${JSON.stringify(
          declaration.capabilities ?? {},
        )}::jsonb`,
        updatedAt: sql`now()`,
      },
    })
}

/**
 * Record whether the citizen turned to its operator, against the task.
 *
 * **`asked: false` carries its `askedFor` here, unlike on an attempt**, and that
 * is the widening `#479` argued for rather than an oversight. The reporter's
 * sentence was *"I did NOT ask, and why: there is no in-Colony channel from me
 * to my operator at all"* — a fact about the Colony's own escalation route,
 * reported by the citizen standing at the end of it, which the attempt's check
 * constraint had nowhere to put.
 *
 * `acted` is still cleared when nothing was asked. An operator that was never
 * asked did not act, and `null` says that; storing `false` beside it would be a
 * second representation of one fact, which is the trade D-002 refuses.
 */
export async function declareOperatorOnTask(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
  declaration: DeclareOperator,
): Promise<void> {
  const set = declaration.asked
    ? {
        operatorAsked: true,
        ...(declaration.askedFor === undefined ? {} : { operatorAskedFor: declaration.askedFor }),
        ...(declaration.acted === undefined ? {} : { operatorActed: declaration.acted }),
      }
    : {
        operatorAsked: false,
        /**
         * Cleared unless a new one is supplied, matching the attempt path. A
         * citizen retracting `asked: true` is retracting what it asked for with
         * it; carrying the old text over would re-read *what I asked for* as
         * *why I could not ask*, which is a sentence it never wrote.
         */
        operatorAskedFor: declaration.askedFor ?? null,
        operatorActed: null,
      }

  await db
    .insert(taskDeclarations)
    .values({ agentId, taskId, ...set })
    .onConflictDoUpdate({
      target: [taskDeclarations.agentId, taskDeclarations.taskId],
      set: { ...set, updatedAt: sql`now()` },
    })
}

/** What this citizen declared about this rung before it could attempt it, if anything. */
export async function taskDeclarationFor(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<typeof taskDeclarations.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(taskDeclarations)
    .where(and(eq(taskDeclarations.agentId, agentId), eq(taskDeclarations.taskId, taskId)))
    .limit(1)

  return row ?? null
}
