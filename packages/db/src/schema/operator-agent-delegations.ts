import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { AgentOperatorCapability } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * Direct citizen-to-citizen operator delegations (`#1794`, epic `#1792`).
 *
 * Revoked rows remain as audit history. The partial unique index permits exactly
 * one live request or grant for a directional pair while allowing a fresh row
 * after revocation. Reciprocal grants are independent because the pair is not
 * normalized or traversed.
 */
export const agentOperatorDelegations = pgTable(
  'agent_operator_delegations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operatorAgentId: uuid('operator_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    subjectAgentId: uuid('subject_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    capabilities: text('capabilities').array().$type<AgentOperatorCapability[]>().notNull(),
    status: text('status').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByAgentId: uuid('revoked_by_agent_id').references(() => agents.id, {
      onDelete: 'cascade',
    }),
  },
  (table) => [
    check(
      'agent_operator_delegations_not_self',
      sql`${table.operatorAgentId} <> ${table.subjectAgentId}`,
    ),
    check(
      'agent_operator_delegations_status_check',
      sql`${table.status} in ('pending', 'active', 'revoked')`,
    ),
    check(
      'agent_operator_delegations_capabilities_check',
      sql`${table.capabilities} in (
        array['workplace-read']::text[],
        array['workplace-write']::text[],
        array['message']::text[],
        array['handover']::text[],
        array['workplace-read', 'workplace-write']::text[],
        array['workplace-read', 'message']::text[],
        array['workplace-read', 'handover']::text[],
        array['workplace-write', 'message']::text[],
        array['workplace-write', 'handover']::text[],
        array['message', 'handover']::text[],
        array['workplace-read', 'workplace-write', 'message']::text[],
        array['workplace-read', 'workplace-write', 'handover']::text[],
        array['workplace-read', 'message', 'handover']::text[],
        array['workplace-write', 'message', 'handover']::text[],
        array['workplace-read', 'workplace-write', 'message', 'handover']::text[]
      )`,
    ),
    check(
      'agent_operator_delegations_lifecycle_check',
      sql`(${table.status} = 'pending' and ${table.acceptedAt} is null and ${table.revokedAt} is null and ${table.revokedByAgentId} is null)
        or (${table.status} = 'active' and ${table.acceptedAt} is not null and ${table.revokedAt} is null and ${table.revokedByAgentId} is null)
        or (${table.status} = 'revoked' and ${table.revokedAt} is not null and ${table.revokedByAgentId} in (${table.operatorAgentId}, ${table.subjectAgentId}))`,
    ),
    uniqueIndex('agent_operator_delegations_pair_live_unique')
      .on(table.operatorAgentId, table.subjectAgentId)
      .where(sql`${table.status} in ('pending', 'active')`),
    index('agent_operator_delegations_operator_idx').on(table.operatorAgentId, table.status),
    index('agent_operator_delegations_subject_idx').on(table.subjectAgentId, table.status),
  ],
)
