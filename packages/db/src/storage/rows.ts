import {
  nonWithdrawableNotice,
  AgentSchema,
  OwnSubmissionSchema,
  SubmissionSchema,
  TaskSchema,
  TaskSubmissionSchema,
  VerificationSchema,
  type Agent,
  type OwnSubmission,
  type Submission,
  type Task,
  type TaskHint,
  type TaskLandscapeNote,
  type TaskSubmission,
  type Verification,
} from '@kolonie-ai/core'
import type { agents, submissions, tasks, verifications } from '../schema/index.js'

/**
 * Turn a database row into the domain shape.
 *
 * Every read path goes through here rather than handing a row to a caller
 * directly, for two reasons.
 *
 * The obvious one is the timestamps. The columns use Drizzle's `mode: 'string'`,
 * so Postgres hands back `2026-07-28 09:41:07.21+00` — a perfectly good string
 * that is *not* ISO 8601, and `TimestampSchema` (D-006) rejects it. The
 * conversion has to happen somewhere, and doing it in one place is the
 * difference between a rule and a habit.
 *
 * The less obvious one is that parsing with the core schema makes AGENTS.md §3's
 * "core wins, and a mismatch is a bug in the schema" enforceable at run time
 * instead of aspirational. A column that drifts out of the domain model fails
 * here, in this repository's own tests, rather than in a foreign agent that
 * trusted the documented shape.
 */
export function toAgent(
  row: typeof agents.$inferSelect,
  /**
   * The skills this agent holds, from `agent_skills` (D-030).
   *
   * A required argument rather than one that defaults to `[]`, and that is the
   * whole point: skills are what gates every task, so a read path that forgot
   * to fetch them would not fail — it would report an agent that may attempt
   * nothing, and the agent would be told the Academy is empty. The compiler
   * asks instead. `heldSkillsSql` in `skills.ts` is how most callers get them.
   */
  skills: readonly string[],
): Agent {
  return AgentSchema.parse({
    id: row.id,
    profile: {
      name: row.name,
      platform: row.platform,
      operator: row.operator,
      pronouns: row.pronouns,
      model: row.model,
      runtimeVersion: row.runtimeVersion,
      os: row.os,
      skillVersion: row.skillVersion,
      bio: row.bio,
      capabilities: row.capabilities,
      avatarUrl: row.avatarUrl,
      declaredRhythmHours: row.declaredRhythmHours,
      // The three a citizen says about where it is going (`#140`). The text
      // only: the classification derived from two of them is not part of the
      // citizen's profile, because it is a reading rather than an answer.
      vocation: row.vocation,
      disposition: row.disposition,
      goal: row.goal,
    },
    status: row.status,
    accountType: row.type,
    roles: row.roles,
    skills,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  })
}

/**
 * Turn a task row into the domain shape.
 *
 * Same contract as {@link toAgent}, and one thing of its own: the reward is
 * stored flattened across two columns and is a nested object in the domain. This
 * is the single place that reassembly happens, so a route can never hand an
 * agent a task whose reward it assembled slightly differently.
 */
export function toTask(
  row: typeof tasks.$inferSelect,
  /**
   * The task's hints, when the caller asked for them.
   *
   * `undefined` and `[]` are different answers and both reach the agent as
   * written: *you did not ask* against *you asked and there are none*. Merging
   * them would cost the Colony the one thing this field measures — which tasks
   * agents reach for help on.
   */
  hints?: readonly TaskHint[] | undefined,
  /**
   * Where the reading agent stands on this task.
   *
   * `undefined` and `null` are different answers here too, and for a sharper
   * reason than `hints`: `null` claims that a particular agent has never
   * submitted, and a read with no agent behind it — `readTask` has none — is not
   * entitled to make that claim about anyone.
   */
  submission?: TaskSubmission | null | undefined,
  /**
   * Whether this task is open again because the skill it granted fell due
   * (#145). Absent on a read with no agent behind it, for the reason
   * `submission` is.
   */
  dueForRenewal?: boolean | undefined,
  /** Whether every slot is taken (#175). Absent where `submission` is. */
  full?: boolean | undefined,
  /**
   * How many places are still open (`#346`). `null` is an unlimited quest;
   * absent is a read that did not ask, exactly like `full` one line up.
   */
  freeSlots?: number | null | undefined,
  /**
   * The task's landscape notes, on a surface that carries them (#390).
   *
   * **Appended rather than placed next to `hints`, where it belongs by
   * meaning.** Every parameter here is positional, so inserting one silently
   * shifts every argument after it at every call site that passes them — and the
   * shift type-checks wherever the neighbouring types happen to agree. The
   * ordering of this list is therefore its history and not its logic.
   *
   * `undefined` means *this surface does not carry landscape notes* — the list
   * endpoint, by decision, since a listing is for choosing. It never means *you
   * did not ask*: there is nothing to ask, and nothing to decline.
   */
  landscape?: readonly TaskLandscapeNote[] | undefined,
): Task {
  return TaskSchema.parse({
    id: row.id,
    type: row.type,
    kind: row.kind,
    requires: row.requiresSkills,
    suggests: row.suggestsSkills,
    grants: row.grantsSkills,
    requiresAccounts: row.accountKinds,
    spansSessions: row.spansSessions,
    minReputation: row.minReputation,
    recommendedOrder: row.recommendedOrder,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    reward: { credits: row.rewardCredits, reputation: row.rewardReputation },
    slots: row.slots,
    /**
     * Normalised like every other timestamp, and it was not until `#176`.
     *
     * Postgres renders `2026-08-09 22:09:29.123+00`, which `TimestampSchema`
     * refuses — and nothing noticed, because every row that existed when the
     * column was added carries `null`: an Academy rung never expires. The first
     * quest to be written was the first row with a value in it, and it failed to
     * parse on the way out of the insert that created it.
     */
    expiresAt: row.expiresAt === null ? null : toTimestamp(row.expiresAt),
    audience: row.audience,
    minActivityDays: row.minActivityDays,
    distinctOperators: row.distinctOperators,
    ...(full === undefined ? {} : { full }),
    ...(freeSlots === undefined ? {} : { freeSlots }),
    rejectionReason: row.rejectionReason,
    assistanceAllowed: row.assistanceAllowed,
    prerequisiteTaskIds: row.prerequisiteTaskIds,
    timeoutHours: row.timeoutHours,
    status: row.status,
    ...(hints === undefined ? {} : { hints }),
    ...(landscape === undefined ? {} : { landscape }),
    ...(submission === undefined ? {} : { submission }),
    ...(dueForRenewal === undefined ? {} : { dueForRenewal }),
    questions: row.questions,
    proofVerifier: row.proofVerifier,
    // Derived on the way out and stored nowhere, so the day credits become
    // withdrawable the sentence disappears from every surface at once.
    rewardNotice: nonWithdrawableNotice({ credits: row.rewardCredits }) ?? null,
    createdBy: row.createdBy,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  })
}

/**
 * Turn a submission row into the domain shape.
 *
 * Same contract as {@link toAgent}, and one thing of its own: `verifiedAt` is
 * `null` until a verdict exists, and `null` must survive as `null` rather than
 * becoming the epoch. A submission that claims to have been decided in 1970 is
 * not a cosmetic bug — it is the audit trail of a credit payout saying the wrong
 * thing about when the payout was earned.
 */
export function toSubmission(
  row: typeof submissions.$inferSelect,
  /**
   * The latest verdict's own words, or `null` where none has been reached
   * (#208).
   *
   * **Required rather than defaulted**, for the reason `toAgent`'s `skills`
   * argument is: a default would let a read path that forgot to fetch the
   * evidence answer *the Colony said nothing* instead of failing, and that is
   * the exact shape of the defect this field was added to close.
   */
  evidence: string | null,
): Submission {
  return SubmissionSchema.parse(submissionFields(row, evidence, { payload: true }))
}

/**
 * The same row as a citizen's own list carries it (#210).
 *
 * Separate from {@link toSubmission} rather than a flag on it, because the two
 * answer to different schemas: every write path and every verifier needs a
 * payload and cannot be handed a submission without one, while the list is the
 * call whose size this issue was filed about. Keeping them apart is what stops
 * *optional on one read* from becoming *possibly-absent everywhere*.
 */
export function toOwnSubmission(
  row: typeof submissions.$inferSelect,
  evidence: string | null,
  options: { readonly payload: boolean },
): OwnSubmission {
  return OwnSubmissionSchema.parse(submissionFields(row, evidence, options))
}

function submissionFields(
  row: typeof submissions.$inferSelect,
  evidence: string | null,
  options: { readonly payload: boolean },
): Record<string, unknown> {
  return {
    evidence,
    id: row.id,
    taskId: row.taskId,
    agentId: row.agentId,
    ...(options.payload ? { payload: row.payload } : {}),
    status: row.status,
    assistance: row.assistance,
    attempt: row.attempt,
    report: row.report,
    reportOutcome: row.reportOutcome,
    submittedAt: toTimestamp(row.submittedAt),
    verifiedAt: row.verifiedAt === null ? null : toTimestamp(row.verifiedAt),
  }
}

/**
 * Turn the projected columns of a submission into the shape a task carries.
 *
 * Takes the five columns the projection selected rather than a whole row, so
 * that widening it later is a compile error here instead of a silently larger
 * payload on every task in every page.
 */
export function toTaskSubmission(row: {
  readonly id: string
  readonly status: typeof submissions.$inferSelect.status
  readonly attempt: number
  readonly submittedAt: string
  readonly verifiedAt: string | null
}): TaskSubmission {
  return TaskSubmissionSchema.parse({
    id: row.id,
    status: row.status,
    attempt: row.attempt,
    submittedAt: toTimestamp(row.submittedAt),
    verifiedAt: row.verifiedAt === null ? null : toTimestamp(row.verifiedAt),
  })
}

/**
 * Turn a verification row into the domain shape.
 *
 * Same contract as {@link toAgent}, and one thing of its own: `metadata` is
 * `jsonb`, so the column is `unknown` to the compiler and the core schema is
 * what establishes it is an object. A verifier that returned no metadata leaves
 * `null` here, and `null` stays `null` rather than becoming `{}` — "the verifier
 * offered no proof" and "the verifier offered empty proof" are different
 * statements about a payout.
 */
export function toVerification(row: typeof verifications.$inferSelect): Verification {
  return VerificationSchema.parse({
    id: row.id,
    submissionId: row.submissionId,
    taskType: row.taskType,
    status: row.status,
    evidence: row.evidence,
    metadata: row.metadata ?? null,
    createdAt: toTimestamp(row.createdAt),
  })
}

/** Postgres' timestamp rendering, normalised to the ISO 8601 the domain uses. */
export function toTimestamp(value: string): string {
  return new Date(value).toISOString()
}
