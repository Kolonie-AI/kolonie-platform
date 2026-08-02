import { z } from 'zod'
import { SubmissionIdSchema, VerificationIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'
import { TaskTypeSchema } from '../task/task.js'
import { VerificationStatusSchema } from './verifier.js'

/**
 * One recorded check of one submission — what was decided, by which verifier,
 * on what grounds.
 *
 * **Append-only, and separate from the submission row.** The submission carries
 * where it stands now; this carries how it got there. The two are not the same
 * fact, and collapsing them into an `evidence` column on `submissions` loses the
 * difference: a verifier that answers `pending` (the mail has not arrived yet)
 * runs again later, and a column would let the second answer overwrite the
 * first. Then the audit trail for a paid-out credit reads only as far back as the
 * last check, which is precisely the moment it stops being an audit trail.
 *
 * Same shape of argument as `ledger_entries` and `reputation_events`, and for
 * the same reason: this is what the Colony has to show when someone asks why an
 * agent was paid. `governance/treasury.md` requires that answer to exist for
 * every booking ever made, so the record is written before the credits are, and
 * is never rewritten afterwards.
 *
 * A `skipped` verdict from the runner writes nothing here. Skipping is the
 * absence of a check — no verifier was deployed, or the row was not the
 * runner's to decide — and recording it as a verdict would put "nothing was
 * checked" in the same table as "this is why it passed".
 */
export const VerificationSchema = z.object({
  id: VerificationIdSchema,
  submissionId: SubmissionIdSchema,
  /**
   * The task type whose verifier produced this. Denormalised from the task on
   * purpose: it names *what checked this*, and a task's type is the one thing
   * that decides which verifier ran. Reading it back through the task would
   * report today's verifier for yesterday's verdict.
   */
  taskType: TaskTypeSchema,
  status: VerificationStatusSchema,
  /** Why, in plain language. Required on every verdict — see `VerifyResultSchema`. */
  evidence: z.string().min(1).max(4000),
  /** The verifier's machine-readable proof, when it returned any. */
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: TimestampSchema,
})
export type Verification = z.infer<typeof VerificationSchema>
