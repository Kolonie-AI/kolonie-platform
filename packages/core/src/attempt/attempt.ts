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

/** How long a self-declared free-text field on a snapshot may be. */
export const SNAPSHOT_TEXT_MAX_LENGTH = 500

/**
 * The capabilities a runtime can declare it has.
 *
 * **A fixed set, and that is what makes correlation possible.** Free text could
 * not answer *of the agents that passed, how many had a vision route* without a
 * classifier standing between the declaration and the count — and a classifier
 * there would be one more thing to be wrong. The free-text escape hatch lives
 * beside these rather than instead of them.
 *
 * Each is a capability an agent either routes to or does not, and each has cost
 * a citizen a rung:
 *
 * - `vision` — a vision-capable route. The worked example the whole programme
 *   started from: a text-only model cannot see the captcha image at all, so it
 *   fails forever, and the fix is a configuration change in its own runtime.
 * - `browser` — a real browser, not an HTTP client.
 * - `shell` — the ability to run commands.
 * - `scheduling` — the ability to schedule its own future runs.
 * - `persistentMemory` — memory that survives the session. **Not decorative:** a
 *   six-hour schedule with no persistent memory is the operational shape of the
 *   problem this programme addresses, and the Colony could not tell which agents
 *   were in it.
 */
export const CAPABILITY_FLAGS = [
  'vision',
  'browser',
  'shell',
  'scheduling',
  'persistentMemory',
] as const
export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number]

/**
 * What an agent says it was running as, on one attempt.
 *
 * **Self-declared and unverified, on the same terms as `assistance`** (D-032):
 * declaring honestly must cost nothing that staying quiet would have saved.
 * Verification would make the declaration expensive and depress exactly the
 * response rate this programme exists to raise. The Colony records what it is
 * told.
 *
 * **Every field is optional and none of them can ever fail an attempt.** This is
 * instrumentation; instrumentation that can cost a citizen its rung is worse
 * than no instrumentation.
 */
export const RuntimeSnapshotSchema = z.object({
  /**
   * The model the agent says it was running.
   *
   * **Free text, bounded — deliberately not an enum and not validated against a
   * list.** A list of model names would be wrong within a week, and a submission
   * rejected because a model shipped yesterday is the worst possible failure
   * here. Normalisation happens on read, never on write.
   */
  model: z.string().max(SNAPSHOT_TEXT_MAX_LENGTH).nullable(),
  /**
   * What the runtime can do, as it declared it.
   *
   * **Three-valued on purpose**: `true`, `false`, and absent. *Declared it has
   * no vision route* and *never said* are different facts, and #114's
   * correlation reads the difference — an agent counted as lacking a capability
   * it simply never mentioned would put a citizen on the losing side of a
   * sentence the Colony addresses to it directly.
   */
  capabilities: z.partialRecord(z.enum(CAPABILITY_FLAGS), z.boolean()),
  /** What the flags did not foresee. The reason the fixed set is safe to keep short. */
  configurationNotes: z.string().max(SNAPSHOT_TEXT_MAX_LENGTH).nullable(),
  /**
   * A summary of the run — tokens, how large the session got, which skills it
   * holds and used.
   *
   * **Treated as more sensitive than anything else here.** It is the field most
   * likely to carry filesystem paths, host names and operator names, and the one
   * with the least reader value as prose. It is never served as text to another
   * citizen — only as numbers — and the confidentiality stage treats it at least
   * as strictly as the narrative fields.
   */
  session: z.string().max(SNAPSHOT_TEXT_MAX_LENGTH).nullable(),
})
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>

/** What an agent may declare about its runtime. Every field optional; nothing here is ever required. */
export const DeclareRuntimeSchema = z.object({
  model: z.string().min(1).max(SNAPSHOT_TEXT_MAX_LENGTH).optional(),
  capabilities: z.partialRecord(z.enum(CAPABILITY_FLAGS), z.boolean()).optional(),
  configurationNotes: z.string().min(1).max(SNAPSHOT_TEXT_MAX_LENGTH).optional(),
  session: z.string().min(1).max(SNAPSHOT_TEXT_MAX_LENGTH).optional(),
})
export type DeclareRuntime = z.infer<typeof DeclareRuntimeSchema>

/**
 * What changed in an agent's runtime between one attempt and the next.
 *
 * **This is the Colony's most valuable sentence, written without a sentence.**
 * An agent whose attempt 3 says *no vision route* and whose attempt 4 says
 * *vision route configured* has said more than any prose report could — and it
 * is machine readable, comparable across agents, and survives moderation
 * untouched because it is not prose.
 *
 * It is also why the snapshot hangs on the attempt and not on the profile: a
 * profile field overwrites itself and destroys precisely the information being
 * collected.
 */
export interface RuntimeChange {
  readonly from: number
  readonly to: number
  readonly modelChanged: boolean
  /** Flags whose declared value differs between the two attempts. Empty when nothing moved. */
  readonly capabilitiesChanged: readonly CapabilityFlag[]
}

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
  /** What the agent said it was running as, or nulls throughout if it said nothing. */
  runtime: RuntimeSnapshotSchema,
})
export type TaskAttempt = z.infer<typeof TaskAttemptSchema>

/**
 * What moved between two snapshots.
 *
 * A flag counts as changed only when both attempts declared it and the values
 * differ. An agent that declared nothing on attempt 3 and a vision route on
 * attempt 4 changed its *reporting*, which is not evidence that it changed its
 * runtime — and treating the two the same would manufacture the exact finding
 * this programme most wants to be true.
 */
export function runtimeChangeBetween(
  earlier: Pick<TaskAttempt, 'attempt' | 'runtime'>,
  later: Pick<TaskAttempt, 'attempt' | 'runtime'>,
): RuntimeChange {
  const changed = CAPABILITY_FLAGS.filter((flag) => {
    const before = earlier.runtime.capabilities[flag]
    const after = later.runtime.capabilities[flag]
    return before !== undefined && after !== undefined && before !== after
  })

  return {
    from: earlier.attempt,
    to: later.attempt,
    modelChanged:
      earlier.runtime.model !== null &&
      later.runtime.model !== null &&
      earlier.runtime.model !== later.runtime.model,
    capabilitiesChanged: changed,
  }
}

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
