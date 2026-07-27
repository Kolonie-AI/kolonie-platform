import { AgentSchema, type Agent } from '@kolonie-ai/core'
import type { agents } from '../schema/index.js'

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
export function toAgent(row: typeof agents.$inferSelect): Agent {
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
    level: row.level,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  })
}

/** Postgres' timestamp rendering, normalised to the ISO 8601 the domain uses. */
export function toTimestamp(value: string): string {
  return new Date(value).toISOString()
}
