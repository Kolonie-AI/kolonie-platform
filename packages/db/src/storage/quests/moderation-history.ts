import { and, desc, eq, or, sql } from 'drizzle-orm'
import {
  ModerationStagesSchema,
  type ModerationStages,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../../client.js'
import { questModerations, tasks } from '../../schema/index.js'
import { toTimestamp } from '../rows.js'

export type QuestModerationDecision = 'approved' | 'rejected'
export type QuestModerationRefusalStage = keyof ModerationStages | 'unknown'

/** The two filters the maintainer's audit screen exposes (`#814`). */
export interface QuestModerationHistoryFilters {
  /** A case-insensitive fragment of the quest's title or id. */
  readonly subject?: string | undefined
  readonly decision?: QuestModerationDecision | undefined
}

/**
 * One quest verdict in the form the maintainer may read (`#814`).
 *
 * The digest and the judged prose are deliberately absent. The table proves
 * which text was judged without becoming a second place that publishes it.
 */
export interface QuestModerationHistoryRow {
  readonly subject: { readonly id: TaskId; readonly title: string }
  readonly decision: QuestModerationDecision
  readonly refusalReason: string | null
  readonly refusedAt: QuestModerationRefusalStage | null
  readonly model: string
  readonly stages: ModerationStages
  readonly createdAt: Timestamp
}

const REFUSAL_OUTCOME: Readonly<Record<keyof ModerationStages, string>> = {
  redLine: 'crossed',
  quality: 'unanswerable',
  confidentiality: 'overreaching',
  dedup: 'duplicate',
}

/** Recover which written criterion ended a rejected verdict. */
function refusalOf(
  decision: QuestModerationDecision,
  stages: ModerationStages,
): Pick<QuestModerationHistoryRow, 'refusalReason' | 'refusedAt'> {
  if (decision === 'approved') return { refusalReason: null, refusedAt: null }

  for (const stage of Object.keys(REFUSAL_OUTCOME) as (keyof ModerationStages)[]) {
    if (stages[stage].outcome === REFUSAL_OUTCOME[stage]) {
      return { refusalReason: stages[stage].reason ?? null, refusedAt: stage }
    }
  }

  const reason = Object.values(stages).find((stage) => stage.reason !== undefined)?.reason ?? null
  return { refusalReason: reason, refusedAt: 'unknown' }
}

/**
 * Every quest verdict the Colony has reached, newest first (`#814`).
 *
 * Append-only history is preserved: a refused quest corrected and approved
 * later contributes both rows. Filtering happens in this read so the console
 * never fetches judged prose or an unbounded superset only to discard it.
 */
export async function questModerationHistory(
  db: Database,
  filters: QuestModerationHistoryFilters = {},
): Promise<readonly QuestModerationHistoryRow[]> {
  const subject = filters.subject?.trim()
  const rows = await db
    .select({
      taskId: questModerations.taskId,
      title: tasks.title,
      decision: questModerations.decision,
      model: questModerations.model,
      stages: questModerations.stages,
      createdAt: questModerations.createdAt,
    })
    .from(questModerations)
    .innerJoin(tasks, eq(tasks.id, questModerations.taskId))
    .where(
      and(
        filters.decision === undefined
          ? undefined
          : eq(questModerations.decision, filters.decision),
        subject === undefined || subject === ''
          ? undefined
          : or(
              sql`position(lower(${subject}) in lower(${tasks.title})) > 0`,
              sql`position(lower(${subject}) in lower(${questModerations.taskId}::text)) > 0`,
            ),
      ),
    )
    .orderBy(desc(questModerations.createdAt))

  return rows.map((row) => {
    const decision = row.decision as QuestModerationDecision
    const stages = ModerationStagesSchema.parse(row.stages)
    return {
      subject: { id: row.taskId as TaskId, title: row.title },
      decision,
      ...refusalOf(decision, stages),
      model: row.model,
      stages,
      createdAt: toTimestamp(row.createdAt) as Timestamp,
    }
  })
}
