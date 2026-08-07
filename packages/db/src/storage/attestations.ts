import { and, eq, sql } from 'drizzle-orm'
/**
 * The shape is core's, and it is not restated here (`#519`).
 *
 * Carrying `accountProvedBy` at all is the decision: a rung and a generic proof are not
 * the same claim, and the reader of an attestation is precisely the one entitled to know
 * which it is looking at.
 */
import { SkillSchema, type AccountKind, type Attestation, type Skill } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accounts } from '../schema/accounts.js'
import { agentSkills } from '../schema/agent-skills.js'
import { toTimestamp } from './rows.js'

/**
 * *Does the holder of this address hold this skill?* — answered to a stranger (`#519`).
 *
 * ## Why this exists
 *
 * A skill the Colony grants was visible only inside the Colony. No third party could
 * ask, so the certificate was worth nothing anywhere it would have mattered — which is
 * the gap between what the Academy does and what it is worth. Closing it turns the
 * Colony from a closed game into something that **vouches for agents**, which is the one
 * thing an operator cannot get anywhere else.
 *
 * ## One question, one proof, and never a list
 *
 * The rule that makes it safe: **answer about a proof, never return a list.**
 *
 * - Looked up by an identifier the agent has already made public — its verified domain,
 *   its GitHub handle, its wallet address.
 * - One skill per question, named in the request.
 * - **No enumeration**: nothing lists citizens, nothing browses, nothing answers *what
 *   else does this agent hold*, and nothing reverses a skill into its holders.
 *
 * Without that rule this is a directory of every citizen and everything it owns, and
 * `governance/privacy.md` refuses it — rightly. With it, it is an attestation service
 * and nothing more.
 *
 * ## One answer shape for every reason the answer is no
 *
 * **This is the decision worth reading twice.** An identifier nobody holds, an account
 * whose citizen never opted in, and an account whose citizen simply lacks the skill all
 * answer identically: *no*.
 *
 * Distinguishing them would make this an oracle for the two facts it is most important
 * not to publish — that a given handle belongs to a citizen at all, and that a citizen
 * has declined to be answered about. A `404` for *not opted in* beside a `holds: false`
 * for *opted in and lacking it* tells a stranger which citizens exist and which have
 * something to hide. The same reasoning `handleInboundMail` gives for never bouncing:
 * an error that distinguishes is an oracle.
 *
 * **An erased citizen therefore answers as though it never existed**, which `#429`
 * requires and which falls out of the shape rather than needing a branch: erasure
 * cascades the account rows away, the lookup finds nothing, and *nothing* is already the
 * same answer as *no*.
 *
 * ## Proved only, and the method is carried
 *
 * An asserted account attests to nothing — the citizen's word is what this exists to
 * replace. The proof method travels with the answer, because a rung and a generic proof
 * (`#520`) are different strengths and a reader deciding whether to trust an agent is
 * exactly the reader who should be told which one it is looking at.
 */

/** The one answer given whenever the Colony will not vouch, for any reason. */
const NO: Attestation = { holds: false, grantedAt: null, accountProvedBy: null }

/**
 * Ask the one question.
 *
 * **A single query and no intermediate answer**, so there is no shape in which the
 * caller learns *the identifier exists but* anything. The join is the whole predicate:
 * a proved, in-use, attestable account of this kind with this identifier, whose agent
 * holds this skill.
 */
export async function attestation(
  db: Database,
  kind: AccountKind,
  identifier: string,
  skill: Skill,
): Promise<Attestation> {
  const [row] = await db
    .select({
      grantedAt: agentSkills.grantedAt,
      provedBy: accounts.provedBy,
    })
    .from(accounts)
    .innerJoin(
      agentSkills,
      and(eq(agentSkills.agentId, accounts.agentId), eq(agentSkills.skill, skill)),
    )
    .where(
      and(
        eq(accounts.kind, kind),
        sql`lower(${accounts.identifier}) = lower(${identifier})`,
        eq(accounts.proved, true),
        eq(accounts.attestable, true),
        eq(accounts.status, 'in-use'),
      ),
    )
    .limit(1)

  if (row === undefined) return NO

  return {
    holds: true,
    grantedAt: toTimestamp(row.grantedAt),
    /**
     * Coalesced the same way `toAccount` coalesces it: a proved row with no recorded
     * method is rung-proved, because before `#520` a rung was the only thing that could
     * set `proved`.
     */
    accountProvedBy: (row.provedBy ?? 'rung') as Attestation['accountProvedBy'],
  }
}

/** The skill vocabulary, so a route can refuse a slug that is not one. */
export function isAttestableSkill(value: string): value is Skill {
  return SkillSchema.safeParse(value).success
}
