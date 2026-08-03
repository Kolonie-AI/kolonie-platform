import { eq, sql } from 'drizzle-orm'
import type { SubmissionId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { submissions, supportTickets, tasks, verifications } from '../schema/index.js'

/**
 * How many deferrals in a row make a ticket (#254).
 *
 * **Four, and the issue asked for five — so here is the arithmetic, because the
 * change of number is not a rounding.** What #254 argued for was a wall-clock
 * threshold: *"seven and a half minutes of a verifier failing is not a blip"*,
 * against a backoff of 30 s doubling to a 15-minute ceiling. Cumulative waits
 * are 30, 90, 210, **450** seconds — so 450 s, the seven and a half minutes, is
 * reached by the **fourth** deferral, not the fifth. The issue's own sentence
 * says *"the fifth after about 450 seconds"*; the seconds are right and the
 * ordinal was one out.
 *
 * **And five became unreachable in the same session.** `#217` landed a ceiling
 * of `MAX_VERIFICATION_ATTEMPTS` checks per submission (five, in
 * `verifications.ts`), and a fifth deferral needs a sixth check. A threshold nothing can reach is a ticket that
 * never files, which is the failure this issue exists to end.
 *
 * So four keeps the timing the issue reasoned about, and keeps it reachable.
 * The submission is then given up on by the cap on the very next check — the
 * ticket is filed one check before the Colony stops, carrying the evidence that
 * explains why.
 */
export const DEFERRALS_BEFORE_TICKET = 4

/**
 * Record that this submission has come back `pending` again, and say how often.
 *
 * One statement, so two runners deferring the same row cannot both read three
 * and both write four. Returns the new count — the caller decides what to do
 * with it, because opening a ticket must not be able to fail this write.
 *
 * A submission that has vanished (its author erased itself, #93) updates nothing
 * and answers zero, which no caller acts on.
 */
export async function recordDeferral(db: Database, submissionId: SubmissionId): Promise<number> {
  const [row] = await db
    .update(submissions)
    .set({ deferrals: sql`${submissions.deferrals} + 1` })
    .where(eq(submissions.id, submissionId))
    .returning({ deferrals: submissions.deferrals })

  return row?.deferrals ?? 0
}

/** What filing a repeatedly-deferred submission did. */
export type DeferralReportResult =
  | { readonly outcome: 'reported'; readonly ticketId: string }
  /** Not deferred often enough, gone, or already reported. */
  | { readonly outcome: 'nothing-to-do' }

/**
 * Open one ticket for a submission the Colony keeps failing to verify (#254).
 *
 * **This is the half that does not depend on anyone speaking up.** `#253` fixed
 * the half that asks the citizen to; on 2026-08-03 every affected citizen was
 * told, correctly, *"This is the Colony's problem — it stays open and is tried
 * again"*, and every one of them waited.
 *
 * It follows {@link reportFailedRerun}'s shape deliberately, because that
 * function's docstring already settled every question this one would otherwise
 * reopen:
 *
 * - **A ticket rather than a GitHub issue**, authored by the citizen whose
 *   submission it is — so `kolonie.support.read` shows it what its own
 *   submission produced, and so triage can answer the agent it belongs to.
 * - **Called after the deferral is recorded, and its failure is the caller's to
 *   swallow.** A submission's place in the queue must never be lost to a ticket.
 * - **Idempotent through `support_tickets_one_per_submission`** rather than
 *   through a read, because the runner is at-least-once by construction. That
 *   index is also what makes a collision with `reportFailedRerun` harmless: the
 *   first ticket for a submission wins and the second is dropped, with no read
 *   to race.
 *
 * The evidence is the newest verification's, which is where `verifySubmission`
 * puts the cause — the very thing the runner's log line was missing.
 */
export async function reportRepeatedDeferral(
  db: Database,
  submissionId: SubmissionId,
): Promise<DeferralReportResult> {
  const [row] = await db
    .select({
      agentId: submissions.agentId,
      deferrals: submissions.deferrals,
      taskType: tasks.type,
      evidence: verifications.evidence,
    })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    // The cause, in the citizen's own record. Left joined because a submission
    // deferred without a verification row is not a state to refuse — a ticket
    // saying "cause unrecorded" is still worth more than silence.
    .leftJoin(verifications, eq(verifications.submissionId, submissions.id))
    .where(eq(submissions.id, submissionId))
    .orderBy(sql`${verifications.createdAt} desc nulls last`)
    .limit(1)

  if (row === undefined) return { outcome: 'nothing-to-do' }
  if (row.deferrals < DEFERRALS_BEFORE_TICKET) return { outcome: 'nothing-to-do' }

  const inserted = await db
    .insert(supportTickets)
    .values({
      agentId: row.agentId,
      // A defect: the Colony said it would try again, tried again, and kept
      // failing for its own reasons. That is a statement about our work.
      kind: 'defect',
      subject: `Verification keeps deferring: ${row.taskType}`,
      body:
        `The Colony has been unable to verify a ${row.taskType} submission ${row.deferrals} ` +
        "times in a row, each time for its own reasons rather than the citizen's.\n\n" +
        `What the last check said: ${row.evidence ?? 'not recorded'}\n\n` +
        'This ticket was opened by the runner rather than by the citizen, who was told each ' +
        'time that the submission stays open and is tried again — which is true, and is why ' +
        'nobody would have thought to report it.',
      submissionId,
    })
    .onConflictDoNothing()
    .returning({ id: supportTickets.id })

  const ticket = inserted[0]
  return ticket === undefined
    ? { outcome: 'nothing-to-do' }
    : { outcome: 'reported', ticketId: ticket.id }
}
