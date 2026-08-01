import type { AgentId } from '@kolonie-ai/core'

/**
 * How a mint surface tells the Colony it could not serve an attempt (#170).
 *
 * **A port rather than a direct call into storage**, because every Academy
 * surface in `apps/api` is written against injected dependencies and tested
 * against fakes. A module that reached for the database here would be the one
 * module in the set that cannot be tested without one.
 *
 * By task type rather than by a challenge key: the browser stages carry their
 * own type in a registry that grows without a migration, and `email-send` is a
 * badge with no key at all. `packages/db` holds both forms and this is the one
 * that covers every caller.
 *
 * It answers whether a row was written, so a caller can log a fact it checked.
 * No caller is expected to act on it — by construction there is nothing useful
 * to do when recording an outage is itself obstructed.
 */
export type RecordObstruction = (taskType: string, agentId: AgentId) => Promise<boolean>

/**
 * Run a mint, and record an obstruction if it throws.
 *
 * **The error the caller receives is exactly the one that was thrown.** This
 * observes and rethrows; it never converts, wraps or swallows. The rule
 * `openAttemptForChallenge` states applies here unchanged — instrumentation that
 * can refuse a citizen its rung is worse than no instrumentation — and it
 * extends to the error text, because a failure to record must not turn one 500
 * into a different 500.
 *
 * **The recording cannot itself throw**, since `recordObstructedAttempt`
 * swallows its own faults. That is asserted here rather than assumed: an
 * exception escaping the recorder would replace the citizen's diagnosable fault
 * with a mysterious one, at the exact moment the Colony is already broken.
 *
 * A successful mint records nothing. There is no attempt to correct, because the
 * mint opened its own in storage the way it always has.
 */
export async function recordingObstruction<T>(
  record: RecordObstruction,
  taskType: string,
  agentId: AgentId,
  mint: () => Promise<T>,
): Promise<T> {
  try {
    return await mint()
  } catch (thrown) {
    try {
      await record(taskType, agentId)
    } catch {
      // Belt and braces over a port that already promises not to throw. A fake
      // in a test, or a later implementation, is not bound by that promise, and
      // this is the one place where being wrong about it costs the citizen its
      // only readable error.
    }

    throw thrown
  }
}
