import {
  AgentIdSchema,
  CredentialIdSchema,
  type Agent,
  type AgentCredentials,
  type RegisterAgentRequest,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { generateApiKey, hashApiKey } from '../api-key.js'
import { agents, credentials } from '../schema/index.js'
import { toAgent } from './rows.js'

/**
 * What registration did.
 *
 * A rejected registration is not an exception. Two agents choosing the same name
 * is an ordinary event on a public front door, and modelling the ordinary case
 * as a thrown error pushes the caller into catching-and-inspecting — at which
 * point a genuine database fault and a taken name arrive through the same
 * channel and get the same handling. A thrown error here means something is
 * actually broken.
 */
export type RegisterAgentResult =
  | {
      readonly outcome: 'registered'
      readonly agent: Agent
      /** The plaintext key. Exists once, here. Do not log it, do not store it. */
      readonly credentials: AgentCredentials
    }
  | { readonly outcome: 'name-taken'; readonly name: string }
  | { readonly outcome: 'wallet-taken'; readonly wallet: string }

/** The unique indexes that mean "someone got here first" rather than "we are broken". */
const CONFLICTING_INDEX = {
  agents_name_unique: 'name-taken',
  agents_wallet_unique: 'wallet-taken',
} as const

/**
 * Create an agent and issue its first API key, atomically.
 *
 * The transaction is the point. An agent row without a credential is an account
 * nobody can ever authenticate as and nobody can re-create either, because the
 * name it holds is now taken — a permanently dead registration. The two writes
 * are one fact and have to commit or fail as one.
 *
 * Uniqueness is enforced by asking the database rather than by checking first:
 * a `SELECT` before an `INSERT` is a race, and two agents registering the same
 * name in the same millisecond is exactly the case a front door has to survive.
 * The index is the check; this function only translates its verdict.
 */
export async function registerAgent(
  db: Database,
  request: RegisterAgentRequest,
): Promise<RegisterAgentResult> {
  const apiKey = generateApiKey()

  try {
    return await db.transaction(async (tx) => {
      const [agentRow] = await tx
        .insert(agents)
        .values({
          name: request.name,
          platform: request.platform,
          operator: request.operator,
          capabilities: request.capabilities,
          wallet: request.wallet,
          // status, roles and level are left to the column defaults: `candidate`,
          // no roles, level 0 (D-001). Restating them here would create a second
          // place where "what a new agent starts as" is written down.
        })
        .returning()

      if (agentRow === undefined) {
        throw new Error('insert into agents returned no row')
      }

      const [credentialRow] = await tx
        .insert(credentials)
        .values({
          agentId: agentRow.id,
          kind: 'api-key',
          // `null` on purpose: the key issued at registration is the agent's
          // default credential and has no name to distinguish it from. Labels
          // are for the keys an agent adds later.
          label: null,
          secretHash: hashApiKey(apiKey),
        })
        .returning()

      if (credentialRow === undefined) {
        throw new Error('insert into credentials returned no row')
      }

      return {
        outcome: 'registered',
        agent: toAgent(agentRow),
        credentials: {
          agentId: AgentIdSchema.parse(agentRow.id),
          credentialId: CredentialIdSchema.parse(credentialRow.id),
          kind: 'api-key',
          apiKey,
          issuedAt: new Date(credentialRow.issuedAt).toISOString(),
        },
      }
    })
  } catch (error) {
    const conflict = conflictingIndex(error)
    if (conflict === 'name-taken') return { outcome: 'name-taken', name: request.name }
    if (conflict === 'wallet-taken') {
      // Unreachable unless a wallet was supplied — that is the only way this
      // index can be violated.
      return { outcome: 'wallet-taken', wallet: request.wallet ?? '' }
    }
    throw error
  }
}

/**
 * Which unique index a failure violated, if any.
 *
 * Drizzle wraps the driver error, so the constraint name lives on a `cause`
 * several levels down rather than on the error that was thrown. Matching the
 * index by name — not by SQLSTATE alone — is what keeps this honest: a future
 * unique index added to `agents` will not be silently reported as a taken name.
 */
function conflictingIndex(
  error: unknown,
): (typeof CONFLICTING_INDEX)[keyof typeof CONFLICTING_INDEX] | undefined {
  let current: unknown = error
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code
    const constraint = (current as { constraint_name?: unknown }).constraint_name
    // 23505 = unique_violation.
    if (code === '23505' && typeof constraint === 'string' && constraint in CONFLICTING_INDEX) {
      return CONFLICTING_INDEX[constraint as keyof typeof CONFLICTING_INDEX]
    }
    current = current.cause
  }
  return undefined
}
