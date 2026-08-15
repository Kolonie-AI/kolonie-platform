import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import type { AgentId, OperatorStanding } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  humanAgents,
  humanIdentities,
  humanLinkCodes,
  operatorClaimChallenges,
  operatorClaims,
  operatorPages,
} from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * Everything the Colony has verified about the person behind this citizen
 * (`#1013`).
 *
 * **One read across four tables rather than four ports**, because the question
 * the citizen asks is one question — *where do I stand with my operator* — and
 * the failure `#1013` reports is exactly what happens when the answer is
 * assembled by the caller: the reporter had a console link, could see no field
 * saying so, and went back to a person who had already answered.
 *
 * The four sources answer four different things and none of them substitutes for
 * another: `human_agents` is the private channel, `operator_claims` the public
 * vouch, `human_link_codes` an ask nobody has answered yet, and `operator_pages`
 * whether anybody is reading.
 *
 * **Expiry is evaluated by the database**, for `openOperatorClaim`'s reason: the
 * clock that decides is the one the row was written against, and a caller
 * comparing timestamps in its own process is one deployment skew away from
 * calling a dead code live.
 *
 * **No address and no code leaves here.** See `OperatorStandingSchema` — the
 * citizen is told whether a person is reachable and whether a code is
 * outstanding, and reads neither value.
 */
export async function operatorStandingOf(
  db: Database,
  agentId: AgentId,
): Promise<OperatorStanding> {
  const [link] = await db
    .select({ humanId: humanAgents.humanId, linkedAt: humanAgents.linkedAt })
    .from(humanAgents)
    .where(eq(humanAgents.agentId, agentId))
    .limit(1)

  /**
   * The same rule `linkedOperator` states: the newest identity carrying an
   * address decides, so a person who attached GitHub with a private address and
   * Google with a public one is reachable.
   */
  const reachable =
    link === undefined
      ? []
      : await db
          .select({ email: humanIdentities.email })
          .from(humanIdentities)
          .where(
            and(
              eq(humanIdentities.humanId, link.humanId),
              sql`${humanIdentities.email} is not null`,
            ),
          )
          .limit(1)

  // Only asked when there is no link — a code outstanding against a link that
  // has since been made is spent history, and reporting it would send a citizen
  // back to an operator who has already finished.
  const pendingCode =
    link !== undefined
      ? []
      : await db
          .select({ id: humanLinkCodes.id })
          .from(humanLinkCodes)
          .where(
            and(
              eq(humanLinkCodes.agentId, agentId),
              isNull(humanLinkCodes.usedAt),
              gt(humanLinkCodes.expiresAt, sql`now()`),
            ),
          )
          .limit(1)

  const [claim] = await db
    .select({ handle: operatorClaims.handle, claimedAt: operatorClaims.claimedAt })
    .from(operatorClaims)
    .where(and(eq(operatorClaims.agentId, agentId), isNull(operatorClaims.replacedAt)))
    .limit(1)

  // Same ordering argument as the code above: a string minted before the vouch
  // that is now standing says nothing a citizen should act on.
  const pendingClaim =
    claim !== undefined
      ? []
      : await db
          .select({ claim: operatorClaimChallenges.claim })
          .from(operatorClaimChallenges)
          .where(
            and(
              eq(operatorClaimChallenges.agentId, agentId),
              isNull(operatorClaimChallenges.usedAt),
              gt(operatorClaimChallenges.expiresAt, sql`now()`),
            ),
          )
          .limit(1)

  const pages = await db
    .select({ issuedAt: operatorPages.issuedAt, lastOpenedAt: operatorPages.lastOpenedAt })
    .from(operatorPages)
    .where(and(eq(operatorPages.agentId, agentId), isNull(operatorPages.revokedAt)))
    .orderBy(desc(operatorPages.issuedAt))

  // The most recently opened of them, which is not necessarily the newest: an
  // operator returning to a page issued a month ago is the case the field is for.
  const opened = pages
    .map((page) => page.lastOpenedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1)

  return {
    consoleLink: {
      status: link !== undefined ? 'linked' : pendingCode.length > 0 ? 'pending_code' : 'none',
      linkedAt: link === undefined ? null : toTimestamp(link.linkedAt),
      reachable: reachable.length > 0,
    },
    publicClaim: {
      status: claim !== undefined ? 'claimed' : pendingClaim.length > 0 ? 'pending' : 'none',
      handle: claim?.handle ?? null,
      claimedAt: claim === undefined ? null : toTimestamp(claim.claimedAt),
    },
    pages: {
      live: pages.length,
      lastIssuedAt: pages[0] === undefined ? null : toTimestamp(pages[0].issuedAt),
      lastOpenedAt: opened === undefined ? null : toTimestamp(opened),
    },
  }
}
