import { eq } from 'drizzle-orm'
import {
  AgentOperatorDelegationSchema,
  decideDelegatedAuthorization,
  type DelegatedAuthorization,
  type DelegatedAuthorizationAsk,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentOperatorDelegations } from '../schema/index.js'

/**
 * The one seam every delegated act goes through (`#1795`, epic `#1792`).
 *
 * It loads the named row and hands it to the pure decision in core, so
 * Workplace and messaging cannot drift into two rules. **No caller passes a
 * subject**: the subject is what the delegation says it is, and a delegated
 * write records actor, subject and delegation id together.
 *
 * Nothing about a citizen key, a human operator identity, a vault value or a
 * wallet is read here or returned — the delegation names capabilities and
 * nothing else can be reached through it.
 */
export async function authorizeAgentOperatorDelegation(
  db: Database,
  ask: DelegatedAuthorizationAsk,
): Promise<DelegatedAuthorization> {
  const [row] = await db
    .select()
    .from(agentOperatorDelegations)
    .where(eq(agentOperatorDelegations.id, ask.delegationId))
    .limit(1)
  if (!row) return { outcome: 'not-found' }

  return decideDelegatedAuthorization(
    AgentOperatorDelegationSchema.parse({
      ...row,
      requestedAt: row.requestedAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    }),
    ask,
  )
}
