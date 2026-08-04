import { and, asc, desc, eq, isNotNull } from 'drizzle-orm'
import {
  AttemptRuntimeDeclarationSchema,
  bioMaterial,
  HistoryRequestSchema,
  memoryBlock,
  narrowHistory,
  TaskHistorySchema,
  type AgentHistoryResponse,
  type AgentId,
  type AttemptRuntimeDeclaration,
  type HistoryRequest,
  type OwnReport,
  type TaskHistory,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { taskAttempts, tasks } from '../schema/index.js'
import { toTimestamp } from './rows.js'
import { RUNTIME_DECLARATION_HISTORY_LIMIT, runtimeDeclarationsOf } from './agents.js'
import { recentSessions } from './sessions.js'
import { reputationOfAgent } from './balance.js'
import { listOwnReports } from './guidance.js'
import { skillsOfAgent } from './skills.js'

/**
 * Every declaration this citizen made against an attempt, newest first (#228).
 *
 * **Its own read rather than a projection of the attempts already fetched
 * above**, because the two answer different questions and one of them is
 * bounded. The trajectory is grouped by task and carries every attempt whether
 * or not anything was declared on it; this is the sequence of *declarations*,
 * ordered by when they were made and cut at the same limit the profile-sourced
 * read uses.
 *
 * The runtime block is the attempt's own, which is the merged state described on
 * {@link AttemptRuntimeDeclarationSchema}. There is no history *within* an
 * attempt: a citizen that declares twice on one try has told the Colony one
 * thing twice, and `runtime_declared_at` records the later of them.
 */
export async function attemptRuntimeDeclarationsOf(
  db: Database,
  agentId: AgentId,
  limit = RUNTIME_DECLARATION_HISTORY_LIMIT,
): Promise<readonly AttemptRuntimeDeclaration[]> {
  const rows = await db
    .select({
      taskId: taskAttempts.taskId,
      attempt: taskAttempts.attempt,
      declaredAt: taskAttempts.runtimeDeclaredAt,
      model: taskAttempts.model,
      capabilities: taskAttempts.capabilities,
      configurationNotes: taskAttempts.configurationNotes,
      session: taskAttempts.session,
    })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, agentId), isNotNull(taskAttempts.runtimeDeclaredAt)))
    .orderBy(desc(taskAttempts.runtimeDeclaredAt))
    .limit(limit)

  return rows.map((row) =>
    AttemptRuntimeDeclarationSchema.parse({
      source: 'tasks.runtime',
      taskId: row.taskId,
      attempt: row.attempt,
      declaredAt: toTimestamp(row.declaredAt!),
      runtime: {
        model: row.model,
        capabilities: row.capabilities,
        configurationNotes: row.configurationNotes,
        session: row.session,
      },
    }),
  )
}

/**
 * When the task's wording moved after this citizen cleared it, or `null`
 * (`#209`).
 *
 * One function because the comparison is the whole content of the field, and a
 * comparison written at two call sites is one that eventually disagrees with
 * itself. Strictly after: a revision at the same instant as the pass is the seed
 * writing the task the citizen just cleared, which is not news for anybody.
 */
function revisedSince(textRevisedAt: string, passedAt: string | undefined): string | null {
  if (passedAt === undefined) return null

  const revised = toTimestamp(textRevisedAt)
  return Date.parse(revised) > Date.parse(passedAt) ? revised : null
}

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
export async function readHistory(
  db: Database,
  agentId: AgentId,
  request: HistoryRequest = HistoryRequestSchema.parse({}),
): Promise<AgentHistoryResponse> {
  const rows = await db
    .select({
      taskId: taskAttempts.taskId,
      taskType: tasks.type,
      title: tasks.title,
      attempt: taskAttempts.attempt,
      openedAt: taskAttempts.openedAt,
      outcome: taskAttempts.outcome,
      model: taskAttempts.model,
      capabilities: taskAttempts.capabilities,
      configurationNotes: taskAttempts.configurationNotes,
      session: taskAttempts.session,
      operatorAsked: taskAttempts.operatorAsked,
      operatorAskedFor: taskAttempts.operatorAskedFor,
      operatorActed: taskAttempts.operatorActed,
      attemptId: taskAttempts.id,
      closedAt: taskAttempts.closedAt,
      /**
       * When the Colony last changed what this task asks for (`#182`, `#209`).
       *
       * Carried on every attempt row and reduced to one answer per task below,
       * because the comparison it feeds is between this and the moment *this
       * citizen* cleared the rung — which is a property of the attempts rather
       * than of the task.
       */
      textRevisedAt: tasks.textRevisedAt,
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
      openedAt: toTimestamp(row.openedAt),
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

    /**
     * When this citizen cleared the rung, from the attempt that did it (`#209`).
     *
     * `closed_at` rather than `opened_at`: the rung is cleared when the verdict
     * lands, and an attempt open for six hours would otherwise report a revision
     * made while the citizen was still working as one made afterwards. The
     * fallback to `opened_at` covers a passed attempt from before the column
     * existed, and it errs toward *earlier*, which reports a revision the
     * citizen may already have seen rather than silently withholding one.
     */
    const passedAt =
      row.outcome === 'passed' ? toTimestamp(row.closedAt ?? row.openedAt) : undefined

    if (existing === undefined) {
      grouped.set(row.taskId, {
        taskId: row.taskId,
        taskType: row.taskType,
        title: row.title,
        passed: row.outcome === 'passed',
        requirementsRevisedAt: revisedSince(row.textRevisedAt, passedAt),
        attempts: [attempt],
      } as TaskHistory)
      continue
    }

    grouped.set(row.taskId, {
      ...existing,
      passed: existing.passed || row.outcome === 'passed',
      // The earliest pass decides, so a citizen that cleared a rung, saw it
      // rewritten and never attempted again keeps the flag. `??` rather than a
      // max: a task is passed once (D-015), and a renewal pass is a later
      // clearing of the *current* wording, which is exactly the case where the
      // answer should go back to null.
      requirementsRevisedAt:
        passedAt === undefined
          ? existing.requirementsRevisedAt
          : revisedSince(row.textRevisedAt, passedAt),
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
  const [skills, reputation, profileDeclarations, attemptDeclarations, sessions] =
    await Promise.all([
      skillsOfAgent(db, agentId),
      reputationOfAgent(db, agentId),
      /**
       * What this citizen has said it runs on, and when (#139, #228).
       *
       * Served here because this is the citizen's own record, and the history is
       * the half of the field worth having — the current value is on the profile.
       * Nothing derives anything from it: it gates no task and orders no listing.
       *
       * Two reads because there are two ways to say it, and telling them apart is
       * the whole of `#228`. They are merged below rather than in SQL: a union of
       * two shapes that share only a timestamp is a query that returns neither of
       * them properly.
       */
      runtimeDeclarationsOf(db, agentId),
      attemptRuntimeDeclarationsOf(db, agentId),
      /**
       * The runs it named, and what happened in each (#158).
       *
       * Beside the declarations above because it is the same kind of fact — self
       * declared, unverifiable, nobody else's business — and because both answer
       * questions about a trajectory rather than about a moment.
       */
      recentSessions(db, agentId),
    ])

  return {
    /**
     * The list is narrowed and the two derived blocks are not (`#259`).
     *
     * `memory` and `material` are computed from `history` — the whole record —
     * whatever was asked for. A citizen reading one task's history and then
     * pasting the block into its memory file must not overwrite a complete
     * record with a fragment, and a bio written from *tasks attempted since
     * Tuesday* would be a false statement about a citizen.
     */
    tasks: [...narrowHistory(history, request)],
    memory: memoryBlock(history),
    material: bioMaterial(history, { skills, reputation }),
    /**
     * Both kinds of declaration in one sequence, newest first, and each saying
     * which call made it (`#228`).
     *
     * Bounded to the same limit the profile-sourced read has always used: this
     * response is part of a wake-up loop, and a citizen declaring on every
     * attempt would otherwise grow it without end.
     */
    runtimeDeclarations: [...profileDeclarations, ...attemptDeclarations]
      .sort((first, second) => (first.declaredAt < second.declaredAt ? 1 : -1))
      .slice(0, RUNTIME_DECLARATION_HISTORY_LIMIT),
    sessions: [...sessions],
  }
}
