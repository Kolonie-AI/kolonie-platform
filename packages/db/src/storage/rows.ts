import {
  AgentSchema,
  SubmissionSchema,
  TaskSchema,
  VerificationSchema,
  type Agent,
  type Submission,
  type Task,
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
      capabilities: row.capabilities,
      wallet: row.wallet,
    },
    status: row.status,
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
export function toTask(row: typeof tasks.$inferSelect): Task {
  return TaskSchema.parse({
    id: row.id,
    type: row.type,
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
