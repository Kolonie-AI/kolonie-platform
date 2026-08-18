import { and, desc, eq, sql } from 'drizzle-orm'
import {
  PLAYBOOK_BLOCKED_MIN_BLOCKED,
  PLAYBOOK_BLOCKED_REPORT_WINDOW,
  type Playbook,
  type PlaybookRunOutcome,
  type PlaybookStatus,
  type PlaybookStatusDecisionSource,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { playbookStatusEvents } from '../schema/playbook-status-events.js'
import { playbookRuns, playbooks } from '../schema/playbooks.js'

function asPlaybook(row: typeof playbooks.$inferSelect): Playbook {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    status: row.status as PlaybookStatus,
    authorAgentId: row.authorAgentId,
    parentPlaybookId: row.parentPlaybookId,
    version: row.version,
    requiredAccounts: [...row.requiredAccounts],
    steps: [...row.steps],
    inspiration: [...row.inspiration],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    refusalReason: row.refusalReason,
    statusReason: row.statusReason ?? null,
    statusChangedAt: row.statusChangedAt ?? null,
    statusChangedBy: row.statusChangedBy ?? null,
  }
}

/**
 * Whether the current revision's recent runs justify setting `blocked` (`#1256`).
 *
 * Reads the most recent {@link PLAYBOOK_BLOCKED_REPORT_WINDOW} runs stamped with
 * the live revision. Fires when at least {@link PLAYBOOK_BLOCKED_MIN_BLOCKED}
 * of them ended `blocked` and none ended `completed`.
 */
export async function playbookMeetsBlockedThreshold(
  db: Database | Transaction,
  playbookId: string,
): Promise<{
  readonly meets: boolean
  readonly revision: number
  readonly window: number
  readonly blocked: number
  readonly completed: number
}> {
  const [live] = await db
    .select({ version: playbooks.version })
    .from(playbooks)
    .where(eq(playbooks.id, playbookId))
    .limit(1)

  if (live === undefined) {
    return { meets: false, revision: 0, window: 0, blocked: 0, completed: 0 }
  }

  const rows = await db
    .select({ outcome: playbookRuns.outcome })
    .from(playbookRuns)
    .where(
      and(eq(playbookRuns.playbookId, playbookId), eq(playbookRuns.playbookRevision, live.version)),
    )
    .orderBy(desc(playbookRuns.updatedAt))
    .limit(PLAYBOOK_BLOCKED_REPORT_WINDOW)

  let blocked = 0
  let completed = 0
  for (const row of rows) {
    const outcome = row.outcome as PlaybookRunOutcome
    if (outcome === 'blocked') blocked++
    if (outcome === 'completed') completed++
  }

  return {
    meets: blocked >= PLAYBOOK_BLOCKED_MIN_BLOCKED && completed === 0,
    revision: live.version,
    window: rows.length,
    blocked,
    completed,
  }
}

export type PlaybookStatusTransitionOutcome =
  | { readonly outcome: 'transitioned'; readonly playbook: Playbook }
  | { readonly outcome: 'unchanged'; readonly playbook: Playbook }
  | { readonly outcome: 'unknown-playbook' }

/**
 * Apply an `open` ↔ `blocked` transition inside an existing transaction (`#1256`).
 *
 * Used by revision cuts that already hold a tx, so the status move and the cut
 * land together. Public wrappers below open their own transaction.
 */
export async function applyPlaybookStatusTransition(
  tx: Transaction,
  command: {
    readonly playbookId: string
    readonly fromStatus: 'open' | 'blocked'
    readonly toStatus: 'open' | 'blocked'
    readonly reason: string
    readonly decidedBy: PlaybookStatusDecisionSource
    readonly at?: string
  },
): Promise<PlaybookStatusTransitionOutcome> {
  const at = command.at ?? new Date().toISOString()

  const [row] = await tx
    .select()
    .from(playbooks)
    .where(eq(playbooks.id, command.playbookId))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown-playbook' }
  if (row.status !== command.fromStatus) {
    return { outcome: 'unchanged', playbook: asPlaybook(row) }
  }

  const [updated] = await tx
    .update(playbooks)
    .set({
      status: command.toStatus,
      statusReason: command.reason,
      statusChangedAt: at,
      statusChangedBy: command.decidedBy,
      updatedAt: at,
    })
    .where(and(eq(playbooks.id, command.playbookId), eq(playbooks.status, command.fromStatus)))
    .returning()

  if (updated === undefined) {
    const [again] = await tx
      .select()
      .from(playbooks)
      .where(eq(playbooks.id, command.playbookId))
      .limit(1)
    if (again === undefined) return { outcome: 'unknown-playbook' }
    return { outcome: 'unchanged', playbook: asPlaybook(again) }
  }

  await tx.insert(playbookStatusEvents).values({
    playbookId: command.playbookId,
    fromStatus: command.fromStatus,
    toStatus: command.toStatus,
    reason: command.reason,
    decidedBy: command.decidedBy,
    decidedAt: at,
  })

  return { outcome: 'transitioned', playbook: asPlaybook(updated) }
}

/**
 * Set a playbook to `blocked` from `open`, recording who and why (`#1256`).
 *
 * **Moderation only.** There is no citizen-facing path that calls this.
 */
export async function blockPlaybook(
  db: Database,
  command: {
    readonly playbookId: string
    readonly reason: string
    readonly decidedBy?: PlaybookStatusDecisionSource
    readonly at?: string
  },
): Promise<PlaybookStatusTransitionOutcome> {
  return db.transaction((tx) =>
    applyPlaybookStatusTransition(tx, {
      playbookId: command.playbookId,
      fromStatus: 'open',
      toStatus: 'blocked',
      reason: command.reason,
      decidedBy: command.decidedBy ?? 'moderation',
      at: command.at,
    }),
  )
}

/**
 * Clear `blocked` back to `open` when a new revision is cut (`#1256`).
 *
 * No-op when the playbook is not currently blocked. Prefer
 * {@link applyPlaybookStatusTransition} when already inside a cut transaction.
 */
export async function clearPlaybookBlocked(
  db: Database,
  command: {
    readonly playbookId: string
    readonly reason: string
    readonly decidedBy?: PlaybookStatusDecisionSource
    readonly at?: string
  },
): Promise<PlaybookStatusTransitionOutcome> {
  return db.transaction((tx) =>
    applyPlaybookStatusTransition(tx, {
      playbookId: command.playbookId,
      fromStatus: 'blocked',
      toStatus: 'open',
      reason: command.reason,
      decidedBy: command.decidedBy ?? 'moderation',
      at: command.at,
    }),
  )
}

/**
 * Apply the blocked threshold to one playbook, or leave it alone (`#1256`).
 *
 * Only moves `open` → `blocked`. Clearing is the revision-cut path.
 */
export async function evaluatePlaybookBlocked(
  db: Database,
  playbookId: string,
): Promise<
  PlaybookStatusTransitionOutcome & {
    readonly threshold: Awaited<ReturnType<typeof playbookMeetsBlockedThreshold>>
  }
> {
  const threshold = await playbookMeetsBlockedThreshold(db, playbookId)
  if (!threshold.meets) {
    const [row] = await db.select().from(playbooks).where(eq(playbooks.id, playbookId)).limit(1)
    if (row === undefined) return { outcome: 'unknown-playbook', threshold }
    return { outcome: 'unchanged', playbook: asPlaybook(row), threshold }
  }

  const reason =
    `${threshold.blocked} of the last ${threshold.window} run reports on revision ` +
    `${threshold.revision} ended blocked and none completed ` +
    `(threshold ${PLAYBOOK_BLOCKED_MIN_BLOCKED} of ${PLAYBOOK_BLOCKED_REPORT_WINDOW}).`

  const result = await blockPlaybook(db, { playbookId, reason })
  return { ...result, threshold }
}

/** The status-transition history of one playbook, newest first. */
export async function playbookStatusHistory(
  db: Database,
  playbookId: string,
): Promise<
  readonly {
    readonly fromStatus: string
    readonly toStatus: string
    readonly reason: string
    readonly decidedBy: string
    readonly decidedAt: string
  }[]
> {
  return db
    .select({
      fromStatus: playbookStatusEvents.fromStatus,
      toStatus: playbookStatusEvents.toStatus,
      reason: playbookStatusEvents.reason,
      decidedBy: playbookStatusEvents.decidedBy,
      decidedAt: playbookStatusEvents.decidedAt,
    })
    .from(playbookStatusEvents)
    .where(eq(playbookStatusEvents.playbookId, playbookId))
    .orderBy(desc(playbookStatusEvents.decidedAt))
}

/**
 * Open playbooks that have enough runs on the live revision to possibly trip
 * the blocked threshold (`#1256`).
 *
 * Narrows to playbooks with at least {@link PLAYBOOK_BLOCKED_MIN_BLOCKED} runs
 * stamped with the live revision ending `blocked`, so the tick does not scan
 * every quiet catalogue entry. Already-blocked playbooks are out — clearing is
 * the revision-cut path.
 */
export async function openPlaybooksForBlockedCheck(
  db: Database,
  limit: number,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: playbooks.id })
    .from(playbooks)
    .where(
      and(
        eq(playbooks.status, 'open'),
        sql`(
          select count(*)::int from ${playbookRuns}
          where ${playbookRuns.playbookId} = ${playbooks.id}
            and ${playbookRuns.playbookRevision} = ${playbooks.version}
            and ${playbookRuns.outcome} = 'blocked'
        ) >= ${PLAYBOOK_BLOCKED_MIN_BLOCKED}`,
      ),
    )
    .orderBy(desc(playbooks.updatedAt))
    .limit(limit)

  return rows.map((row) => row.id)
}
