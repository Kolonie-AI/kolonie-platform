import { and, eq, sql } from 'drizzle-orm'
import { AgentIdSchema, CredentialIdSchema, type Agent, type CredentialId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { apiKeyHashEquals, hashApiKey } from '../api-key.js'
import { agents, credentials } from '../schema/index.js'
import { recordContact } from './contacts.js'
import { attributeCall } from './sessions.js'
import { toAgent } from './rows.js'
import { heldSkillsSql } from './skills.js'

/**
 * What a presented key turned out to be.
 *
 * The three failures are distinguished *here* and collapsed into one answer by
 * the API — `apps/api` must tell a caller only that it is not authenticated. The
 * split is not pointless: storage is where a test can assert that a revoked key
 * is refused *because it is revoked* rather than because the lookup happened to
 * miss, and that assertion is the only thing standing between "revocation works"
 * and "revocation appears to work".
 */
export type AuthenticationResult =
  | {
      readonly outcome: 'authenticated'
      readonly agent: Agent
      readonly credentialId: CredentialId
    }
  /** No credential carries this key. Also the answer for a key that never existed. */
  | { readonly outcome: 'unknown' }
  /** The key was real and has been revoked. Revocation is permanent (D-010). */
  | { readonly outcome: 'revoked' }

/**
 * Resolve an API key to the agent that holds it.
 *
 * The lookup is by hash through `credentials_secret_hash_unique`, which is what
 * D-010 bought by refusing a per-row salt: authentication is one index probe
 * rather than a scan over every credential in the Colony. A salted hash would
 * have made this O(all credentials) on the hottest path in the system.
 *
 * The comparison after the probe looks redundant — Postgres already matched the
 * row — and it is kept because the equality it performs is the timing-safe one.
 * Postgres' own comparison is not, and a database that answers a near-miss
 * measurably slower than a far-miss leaks how many leading characters of a hash
 * an attacker has right. The index probe narrows the field; this decides.
 */
export async function authenticateApiKey(
  db: Database,
  presentedKey: string,
): Promise<AuthenticationResult> {
  const presentedHash = hashApiKey(presentedKey)

  const [row] = await db
    // The skills come back with the agent rather than in a second query: this
    // is the read every authenticated request makes, and what the caller may
    // attempt is decided by them (D-030). A round trip per request to learn
    // what an agent can do would be a round trip on the hottest path in the
    // system.
    .select({ credential: credentials, agent: agents, skills: heldSkillsSql })
    .from(credentials)
    .innerJoin(agents, eq(credentials.agentId, agents.id))
    .where(and(eq(credentials.kind, 'api-key'), eq(credentials.secretHash, presentedHash)))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown' }

  const storedHash = row.credential.secretHash
  // Unreachable while `credentials_api_key_requires_hash` holds — an `api-key`
  // row without a hash cannot be inserted. Checked anyway rather than asserted,
  // because the failure mode of being wrong is authenticating nobody as someone.
  if (storedHash === null) return { outcome: 'unknown' }
  if (!apiKeyHashEquals(storedHash, presentedHash)) return { outcome: 'unknown' }

  if (row.credential.revokedAt !== null) return { outcome: 'revoked' }

  await touch(db, row.credential.id)

  // Contact is recorded here and nowhere else (#141). This function is what both
  // surfaces call — the HTTP routes once per request, MCP once during the
  // handshake and again for every tool that needs a credential — so one call
  // site is the whole of *"one code path, not two"*. Recording it in each
  // surface would mean two implementations that agree until one of them grows a
  // condition.
  //
  // Deliberately after the revocation check and inside the authenticated
  // branch: a caller that could not authenticate has no citizen to attribute
  // anything to, which is why `about`, `register` and the name check record
  // nothing. The outcome is dropped rather than inspected because there is
  // nothing this function could usefully do with it — see `recordContact`,
  // which never throws.
  const agentId = AgentIdSchema.parse(row.agent.id)
  await recordContact(db, agentId)

  // And attribute it to whatever run the citizen last named (#158). A citizen
  // that has never named one is a citizen this statement matches nothing for,
  // which is the ordinary case and costs an indexed lookup.
  await attributeCall(db, agentId)

  return {
    outcome: 'authenticated',
    agent: toAgent(row.agent, row.skills),
    credentialId: CredentialIdSchema.parse(row.credential.id),
  }
}

/**
 * Record that this credential was just used.
 *
 * This is a write on a read path, and it is deliberate. `last_used_at` is what
 * lets an agent notice a key it does not recognise still being used — which is
 * how a leaked credential is spotted at all, given that the plaintext exists
 * nowhere and cannot be searched for. A signal that is recorded only sometimes
 * is not a signal, so it is not sampled and not fire-and-forget.
 *
 * `now()` rather than a value from this process: the timestamp then comes from
 * the same clock as `issued_at` and `revoked_at`, and "used before it was
 * issued" stays impossible even if a container's clock drifts.
 *
 * If this ever costs measurably, the answer is to coarsen it — update only when
 * the stored value is older than some interval — not to drop it.
 */
async function touch(db: Database, credentialId: string): Promise<void> {
  await db
    .update(credentials)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(credentials.id, credentialId))
}
