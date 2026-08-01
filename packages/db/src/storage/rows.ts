import {
  AgentSchema,
  SubmissionSchema,
  TaskSchema,
  TaskSubmissionSchema,
  VerificationSchema,
  type Agent,
  type Submission,
  type Task,
  type TaskHint,
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
      bio: row.bio,
      capabilities: row.capabilities,
      avatarUrl: row.avatarUrl,
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
): Task {
  return TaskSchema.parse({
    id: row.id,
    type: row.type,
    kind: row.kind,
    requires: row.requiresSkills,
    suggests: row.suggestsSkills,
    grants: row.grantsSkills,
    minReputation: row.minReputation,
    recommendedOrder: row.recommendedOrder,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    reward: { coins: row.rewardCoins, reputation: row.rewardReputation },
    assistanceAllowed: row.assistanceAllowed,
    prerequisiteTaskIds: row.prerequisiteTaskIds,
    timeoutHours: row.timeoutHours,
    status: row.status,
    ...(hints === undefined ? {} : { hints }),
    ...(submission === undefined ? {} : { submission }),
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
 * not a cosmetic bug — it is the audit trail of a coin payout saying the wrong
 * thing about when the payout was earned.
 */
export function toSubmission(row: typeof submissions.$inferSelect): Submission {
  return SubmissionSchema.parse({
    id: row.id,
    taskId: row.taskId,
    agentId: row.agentId,
    payload: row.payload,
    status: row.status,
    assistance: row.assistance,
    attempt: row.attempt,
    report: row.report,
    reportOutcome: row.reportOutcome,
    submittedAt: toTimestamp(row.submittedAt),
    verifiedAt: row.verifiedAt === null ? null : toTimestamp(row.verifiedAt),
  })
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
