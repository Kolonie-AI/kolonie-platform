import { asc, eq } from 'drizzle-orm'
import {
  bioMaterial,
  memoryBlock,
  TaskHistorySchema,
  type AgentHistoryResponse,
  type AgentId,
  type OwnReport,
  type TaskHistory,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { taskAttempts, tasks } from '../schema/index.js'
import { reputationOfAgent } from './balance.js'
import { listOwnReports } from './guidance.js'
import { skillsOfAgent } from './skills.js'

/**
 * One citizen's whole history at the Colony, with the block it can take away
 * (#118).
 *
 * **Keyed by the credential's agent and by nothing else.** There is no parameter
 * here a caller could aim at somebody, which is the erasure surface's rule —
 * *"the call cannot be aimed"* — applied to reads for the same reason: a read
 * that takes an agent id is a read somebody eventually calls with an id that is
 * not theirs.
 *
 * **An agent with no history is told so plainly**, not handed an empty
 * structure. `memoryBlock` says it in a sentence, which is what an agent
 * deciding whether to store anything actually needs.
 */
export async function readHistory(db: Database, agentId: AgentId): Promise<AgentHistoryResponse> {
  const rows = await db
    .select({
      taskId: taskAttempts.taskId,
      taskType: tasks.type,
      title: tasks.title,
      attempt: taskAttempts.attempt,
      outcome: taskAttempts.outcome,
      model: taskAttempts.model,
      capabilities: taskAttempts.capabilities,
      configurationNotes: taskAttempts.configurationNotes,
      session: taskAttempts.session,
      operatorAsked: taskAttempts.operatorAsked,
      operatorAskedFor: taskAttempts.operatorAskedFor,
      operatorActed: taskAttempts.operatorActed,
      attemptId: taskAttempts.id,
    })
    .from(taskAttempts)
    .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
    .where(eq(taskAttempts.agentId, agentId))
    .orderBy(asc(taskAttempts.taskId), asc(taskAttempts.attempt))

  /**
   * The reports come from the path that already groups them (#110), rather than
   * from a second join here. One owner for *what this citizen wrote* — this read
   * is about the shape of a trajectory, and a second query that assembled reports
   * its own way would be the first of two answers to the same question.
   */
  const reports = await listOwnReports(db, agentId)
  const byAttempt = new Map<string, OwnReport>(
    reports.map((report) => [report.attemptId as string, report]),
  )

  const grouped = new Map<string, TaskHistory>()
  for (const row of rows) {
    const existing = grouped.get(row.taskId)
    const attempt = {
      attempt: row.attempt,
      outcome: row.outcome,
      runtime: {
        model: row.model,
        capabilities: row.capabilities,
        configurationNotes: row.configurationNotes,
        session: row.session,
      },
      operator: {
        asked: row.operatorAsked,
        askedFor: row.operatorAskedFor,
        acted: row.operatorActed,
      },
      report: byAttempt.get(row.attemptId) ?? null,
    }

    if (existing === undefined) {
      grouped.set(row.taskId, {
        taskId: row.taskId,
        taskType: row.taskType,
        title: row.title,
        passed: row.outcome === 'passed',
        attempts: [attempt],
      } as TaskHistory)
      continue
    }

    grouped.set(row.taskId, {
      ...existing,
      passed: existing.passed || row.outcome === 'passed',
      attempts: [...existing.attempts, attempt],
    } as TaskHistory)
  }

  const history = [...grouped.values()].map((task) => TaskHistorySchema.parse(task))

  /**
   * The material a citizen writes its own bio from (#127).
   *
   * **Counted from `history` rather than queried again**, which is what keeps
   * the two halves of this response from ever disagreeing: the numbers are the
   * list the citizen is reading, summarised. A second query grouping attempts
   * its own way would be the first of two answers to one question, which is the
   * failure #118 already avoided once here.
   *
   * Skills and reputation are the two facts not derivable from the attempts:
   * a skill can be granted by a route other than a pass, and reputation is
   * summed from `reputation_events` and lives in no column (D-012).
   */
  const [skills, reputation] = await Promise.all([
    skillsOfAgent(db, agentId),
    reputationOfAgent(db, agentId),
  ])

  return {
    tasks: history,
    memory: memoryBlock(history),
    material: bioMaterial(history, { skills, reputation }),
  }
}
