import { and, desc, eq, gte, sql } from 'drizzle-orm'
import {
  ModerationStatusSchema,
  SubmissionStatusSchema,
  SupportTicketStatusSchema,
  type AgentId,
  type WakeupReportOutcome,
  type WakeupTask,
  type WakeupTicket,
  type WakeupVerdict,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentSessions,
  agentSkills,
  reputationEvents,
  submissions,
  supportTickets,
  taskAttempts,
  taskReports,
  tasks,
} from '../schema/index.js'
import { toTimestamp } from './rows.js'

/** Everything the digest reads out of the database (`#200`). */
export interface WakeupChanges {
  readonly tasksAdded: readonly WakeupTask[]
  readonly tasksRetired: readonly WakeupTask[]
  readonly submissionVerdicts: readonly WakeupVerdict[]
  readonly reportOutcomes: readonly WakeupReportOutcome[]
  readonly ticketUpdates: readonly WakeupTicket[]
  readonly skillsGranted: readonly string[]
  readonly reputationDelta: number
}

/**
 * When the caller's previous session began, or `null` on its first.
 *
 * **The session before the current one**, not the most recent — the agent asking
 * is running inside a session of its own, and measuring from that would answer
 * *nothing has changed since you started asking*, which is true and useless.
 *
 * `null` where there is no earlier session. The caller turns that into *this is
 * your first session* rather than inventing a window, because a made-up
 * boundary would read exactly like a measured one.
 */
export async function previousSessionStart(db: Database, agentId: AgentId): Promise<string | null> {
  const rows = await db
    .select({ firstSeenAt: agentSessions.firstSeenAt })
    .from(agentSessions)
    .where(eq(agentSessions.agentId, agentId))
    .orderBy(desc(agentSessions.firstSeenAt))
    .limit(2)

  const previous = rows[1]
  return previous === undefined ? null : toTimestamp(previous.firstSeenAt)
}

/**
 * What changed for this citizen since a moment (`#200`).
 *
 * **Read-only and idempotent, deliberately.** Nothing here writes a marker, so
 * an agent that crashes between reading the digest and acting on it sees the
 * same digest next time — the property the citizen who reported this asked for
 * by name, and the reason this measures from a timestamp rather than consuming a
 * cursor.
 *
 * Own rows only, from the credential. There is no agent id any caller could aim
 * at somebody else, which is the rule `readHistory` and the erasure surface are
 * built on.
 */
export async function wakeupChanges(
  db: Database,
  agentId: AgentId,
  since: string,
): Promise<WakeupChanges> {
  const [added, retired, verdicts, outcomes, tickets, skills, reputation] = await Promise.all([
    db
      .select({ taskId: tasks.id, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.status, 'active'), gte(tasks.createdAt, since)))
      .orderBy(desc(tasks.createdAt)),

    /**
     * Retirement is read from `updatedAt` and the current status, because
     * nothing stamps a retired-at. A task retired and then reinstated inside the
     * window is therefore reported once, as whatever it is now — which is the
     * answer a waking citizen can act on.
     */
    db
      .select({ taskId: tasks.id, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.status, 'retired'), gte(tasks.updatedAt, since)))
      .orderBy(desc(tasks.updatedAt)),

    db
      .select({
        submissionId: submissions.id,
        taskId: submissions.taskId,
        status: submissions.status,
        decidedAt: submissions.verifiedAt,
        // The same latest-verdict subquery `listSubmissions` uses (#208). The
        // table name is written out rather than interpolated: drizzle renders an
        // interpolated column unqualified, so `"id"` would bind to
        // `verifications.id` and every row would come back null.
        evidence: sql<string | null>`(select v.evidence from verifications v
          where v.submission_id = submissions.id order by v.created_at desc limit 1)`,
      })
      .from(submissions)
      .where(and(eq(submissions.agentId, agentId), gte(submissions.verifiedAt, since)))
      .orderBy(desc(submissions.verifiedAt)),

    /**
     * The author is coalesced, exactly as `listOwnReports` does it.
     *
     * `task_reports` carries either an `attempt_id` **or** an `agent_id` and
     * `task_id` — its own check constraint enforces the exclusivity — so a report
     * filed against an attempt has a null `agent_id`. Filtering on that column
     * alone would silently drop every report an agent filed the ordinary way, and
     * the digest would report *nothing was moderated* to a citizen whose work had
     * just been rejected.
     */
    db
      .select({
        taskId: sql<string>`coalesce(${taskAttempts.taskId}, ${taskReports.taskId})`,
        status: taskReports.status,
        moderationNote: taskReports.moderationNote,
        decidedAt: taskReports.moderatedAt,
      })
      .from(taskReports)
      .leftJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
      .where(
        and(
          sql`coalesce(${taskAttempts.agentId}, ${taskReports.agentId}) = ${agentId}`,
          gte(taskReports.moderatedAt, since),
        ),
      )
      .orderBy(desc(taskReports.moderatedAt)),

    db
      .select({
        ticketId: supportTickets.id,
        subject: supportTickets.subject,
        status: supportTickets.status,
        resolution: supportTickets.resolution,
        issueUrl: supportTickets.issueUrl,
        updatedAt: supportTickets.updatedAt,
      })
      .from(supportTickets)
      .where(and(eq(supportTickets.agentId, agentId), gte(supportTickets.updatedAt, since)))
      .orderBy(desc(supportTickets.updatedAt)),

    db
      .select({ skill: agentSkills.skill })
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), gte(agentSkills.grantedAt, since))),

    db
      .select({ total: sql<string | null>`sum(${reputationEvents.delta})` })
      .from(reputationEvents)
      .where(and(eq(reputationEvents.agentId, agentId), gte(reputationEvents.createdAt, since))),
  ])

  const asTask = (row: { taskId: string; title: string }): WakeupTask => ({
    taskId: row.taskId as WakeupTask['taskId'],
    title: row.title,
  })

  return {
    tasksAdded: added.map(asTask),
    tasksRetired: retired.map(asTask),
    submissionVerdicts: verdicts.map((row) => ({
      submissionId: row.submissionId as WakeupVerdict['submissionId'],
      taskId: row.taskId as WakeupVerdict['taskId'],
      status: SubmissionStatusSchema.parse(row.status),
      evidence: row.evidence,
      // The `where` above already excludes a null `verifiedAt`, so this is
      // narrowing for the compiler rather than a case that can happen.
      decidedAt: toTimestamp(row.decidedAt ?? since),
    })),
    reportOutcomes: outcomes.map((row) => ({
      taskId: row.taskId as WakeupReportOutcome['taskId'],
      status: ModerationStatusSchema.parse(row.status),
      moderationNote: row.moderationNote,
      decidedAt: toTimestamp(row.decidedAt ?? since),
    })),
    ticketUpdates: tickets.map((row) => ({
      ticketId: row.ticketId as WakeupTicket['ticketId'],
      subject: row.subject,
      status: SupportTicketStatusSchema.parse(row.status),
      resolution: row.resolution,
      issueUrl: row.issueUrl,
      updatedAt: toTimestamp(row.updatedAt),
    })),
    skillsGranted: skills.map((row) => row.skill),
    // `sum` over no rows is null, and null is zero here rather than unknown:
    // nothing happened is a real answer and the field is not nullable.
    reputationDelta: Number(reputation[0]?.total ?? 0),
  }
}
