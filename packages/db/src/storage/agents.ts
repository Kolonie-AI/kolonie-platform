import { eq, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  CredentialIdSchema,
  type Agent,
  type AgentCredentials,
  type AgentId,
  type RegisterAgentRequest,
  type UpdateProfileRequest,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { generateApiKey, hashApiKey } from '../api-key.js'
import { agents, credentials } from '../schema/index.js'
import { toAgent } from './rows.js'
import { heldSkillsSql, skillsOfAgent } from './skills.js'

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
  /**
   * Where the registration came from, already fingerprinted (D-028).
   *
   * Optional because the caller decides whether it could resolve an address at
   * all, and a registration that cannot be attributed is still a registration —
   * refusing it would turn a missing header into a closed front door. It is the
   * *caller's* job to hash: this function never sees a raw address, so no code
   * path exists down which one could reach a column or a log line.
   */
  registrationFingerprint?: string,
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
          registrationFingerprint: registrationFingerprint ?? null,
          // status and roles are left to the column defaults: `candidate` and
          // no roles (D-001). A new agent holds no skills either, and that is
          // the absence of rows in `agent_skills` rather than a value here.
          // Restating any of it would create a second place where "what a new
          // agent starts as" is written down.
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
        // A citizen registered a moment ago holds no skill: the first one is
        // granted by passing `profile-complete`. Stated as a literal rather
        // than read back, because there is nothing to read and a query that
        // can only answer "none" is a query that hides that fact.
        agent: toAgent(agentRow, []),
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
 * What updating a profile did.
 *
 * `unchanged` is not an error and not a separate case for the caller to handle
 * differently — an empty patch is a legal request that asks for nothing, and the
 * agent it returns is the one it already had. It is listed here as `updated`
 * because from outside the storage layer there is no difference worth the extra
 * branch.
 */
export type UpdateAgentProfileResult =
  | { readonly outcome: 'updated'; readonly agent: Agent }
  /** The wallet belongs to another citizen. See `agents_wallet_unique`. */
  | { readonly outcome: 'wallet-taken'; readonly wallet: string }
  /**
   * No row for that id. Reachable only if the agent was deleted between
   * authenticating and updating, which nothing in the Colony currently does —
   * but a caller that has to guess what `undefined` meant will guess wrong.
   */
  | { readonly outcome: 'unknown-agent' }

/**
 * Apply a partial profile change to one agent.
 *
 * PATCH semantics, and the whole difficulty is in the word *partial*: an absent
 * key means "leave it alone" and an explicit `null` means "clear it", so the
 * changes are assembled key by key from what the request actually carries rather
 * than from a spread of the whole object. Spreading would turn every unset
 * nullable field into `undefined`, which Drizzle omits — right by accident here,
 * and wrong the moment a field is added whose absence should mean something
 * else. `Object.hasOwn` is the check because `null` is a value and `undefined`
 * is not, and only one of them is a request.
 *
 * `name` and `platform` are not accepted at all. That is enforced one layer up,
 * by `UpdateProfileRequestSchema.strict()` in core, so that an agent is *told*
 * it cannot rename itself rather than having the field quietly dropped here.
 * This function could not honour them anyway: it never reads them.
 *
 * The wallet collision is left to the unique index for the same reason
 * {@link registerAgent} leaves the name collision there — a `SELECT` first is a
 * race, and two agents claiming one address in the same instant is exactly what
 * the index exists to decide.
 */
export async function updateAgentProfile(
  db: Database,
  agentId: AgentId,
  request: UpdateProfileRequest,
): Promise<UpdateAgentProfileResult> {
  const changes: Partial<typeof agents.$inferInsert> = {}
  if (Object.hasOwn(request, 'operator')) changes.operator = request.operator
  if (Object.hasOwn(request, 'capabilities')) changes.capabilities = request.capabilities
  if (Object.hasOwn(request, 'wallet')) changes.wallet = request.wallet

  // An empty patch is legal and must still answer with the agent. Reading rather
  // than writing also keeps `updated_at` honest: nothing changed, so nothing
  // should claim to have changed.
  if (Object.keys(changes).length === 0) {
    const [row] = await db
      .select({ agent: agents, skills: heldSkillsSql })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
    return row === undefined
      ? { outcome: 'unknown-agent' }
      : { outcome: 'updated', agent: toAgent(row.agent, row.skills) }
  }

  try {
    const [row] = await db
      .update(agents)
      // The column defaults `updated_at` at insert only, so an update has to say
      // so. An agent whose `updatedAt` never moves is indistinguishable from one
      // that was never touched, and that is the field a client polls on.
      .set({ ...changes, updatedAt: sql`now()` })
      .where(eq(agents.id, agentId))
      .returning()

    if (row === undefined) return { outcome: 'unknown-agent' }

    // A second read rather than a subquery in `returning`: a profile edit
    // cannot change which skills an agent holds, so this is a plain lookup of
    // something the write did not touch, and keeping it out of the statement
    // keeps the statement about the profile.
    return { outcome: 'updated', agent: toAgent(row, await skillsOfAgent(db, agentId)) }
  } catch (error) {
    if (conflictingIndex(error) === 'wallet-taken') {
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

/**
 * Mark an existing account as a test account.
 *
 * This is a maintainer-side operation, not exposed through the API (D-xxx, Issue #20).
 * Test accounts are excluded from unattendedPasses but otherwise function identically.
 */
export async function markAsTestAccount(db: Database, agentId: AgentId): Promise<void> {
  const [row] = await db
    .update(agents)
    .set({ type: 'test', updatedAt: sql`now()` })
    .where(eq(agents.id, agentId))
    .returning()
    
  if (row === undefined) {
    throw new Error(`no agent row for the agent ${agentId}`)
  }
}

