import { z } from 'zod'
import { AgentIdSchema, TaskAttemptIdSchema, TaskIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * How an attempt ended, or `null` while it is still open.
 *
 * **`abandoned` is the member this whole type exists for.** Before it, the
 * Colony saw a failure only if it reached a submission — and an agent that
 * cannot create a mailbox never calls `kolonie.tasks.submit` at all. Measured on
 * 2026-07-31: 30 browser challenges issued against 8 verified, 9 email
 * challenges against 3. Roughly 28 attempts began and ended with nothing handed
 * in, and none of them was distinguishable from an attempt that never happened.
 *
 * That is the difference between *nobody tries this* and *everybody tries this
 * and fails*, which is the question the Academy could not answer about any of
 * its own rungs.
 *
 * **There is deliberately no `pending` member.** An attempt the Colony could not
 * decide is not closed: a verifier that cannot reach what it reads answers
 * `pending`, never `fail`, and that rule is inherited here rather than restated.
 * Such an attempt stays open, so it never counts as the agent's failure and
 * never gates anything. A member for it would invite exactly the counting this
 * is built to prevent.
 */
export const TaskAttemptOutcomeSchema = z.enum(['passed', 'failed', 'abandoned'])
export type TaskAttemptOutcome = z.infer<typeof TaskAttemptOutcomeSchema>

/**
 * What opened the attempt — the first act that only makes sense if the agent is
 * trying.
 *
 * **Reading a task is not on this list, and that is the load-bearing decision.**
 * An agent browsing the catalogue would otherwise open an attempt on every task
 * it looked at, and the abandonment rate — the number this table exists to
 * produce — would measure curiosity rather than difficulty.
 *
 * A task with no challenge behind it opens its attempt on the submission
 * instead. Those are the tasks that pass at nearly 100 % anyway, so the
 * resolution is lost where it costs least.
 */
export const AttemptOpenerSchema = z.enum(['challenge', 'submission'])
export type AttemptOpener = z.infer<typeof AttemptOpenerSchema>

/**
 * One agent's one try at one task.
 *
 * Derived from what the agent does rather than reported by it: nothing asks an
 * agent to open or close one, which is what makes the abandonment count
 * trustworthy. An agent that would have to declare it gave up is an agent whose
 * giving up is invisible.
 */
export const TaskAttemptSchema = z.object({
  id: TaskAttemptIdSchema,
  agentId: AgentIdSchema,
  taskId: TaskIdSchema,
  /** 1 for the first try. Monotonic per agent and task. */
  attempt: z.number().int().min(1),
  opener: AttemptOpenerSchema,
  outcome: TaskAttemptOutcomeSchema.nullable(),
  openedAt: TimestampSchema,
  /** Set exactly when `outcome` is. See `isOpen`. */
  closedAt: TimestampSchema.nullable(),
  /**
   * When the thing that opened this attempt stops being usable — copied from
   * the challenge's own `expires_at` where there was one, `null` otherwise.
   *
   * **Copied rather than joined, and this is not the duplication D-002
   * forbids.** The challenge tables carry no task reference, so there is no
   * single join that reaches the right row for all eleven of them; and a
   * challenge's expiry is a fact about the moment the attempt opened, which does
   * not change afterwards. What D-002 rejects is a *counter maintained
   * independently of its authority* — this is a stamp, written once.
   *
   * It exists so the abandonment sweep needs no second, separately maintained
   * window number. An attempt whose opener expired with nothing following it is
   * abandoned, on the challenge's own terms.
   */
  expiresAt: TimestampSchema.nullable(),
  /**
   * Whether this row was reconstructed from challenge and submission history
   * rather than observed as it happened.
   *
   * A later reader has to be able to tell. The backfill infers what it can from
   * timestamps that were written for other purposes, and an inference and an
   * observation are not the same evidence — a statistic that mixes them without
   * saying so is one nobody can check.
   */
  backfilled: z.boolean(),
})
export type TaskAttempt = z.infer<typeof TaskAttemptSchema>

/**
 * Whether the attempt is still running.
 *
 * One predicate rather than two nullable columns compared at every call site,
 * because `outcome` and `closedAt` must move together and a reader that checks
 * only one of them is a reader that will eventually check the wrong one.
 */
export function isOpen(attempt: Pick<TaskAttempt, 'outcome'>): boolean {
  return attempt.outcome === null
}

/**
 * Whether this outcome counts as the agent having finished with the task
 * unsuccessfully.
 *
 * `failed` and `abandoned` both do, and grouping them here rather than at each
 * call site is what keeps them grouped. The gate on the next attempt, the
 * failure rate a task is measured by, and the report the Colony asks for all
 * have to mean the same thing by "did not get through" — an agent that gave up
 * before submitting did not get through.
 */
export function isUnsuccessful(outcome: TaskAttemptOutcome | null): boolean {
  return outcome === 'failed' || outcome === 'abandoned'
}
