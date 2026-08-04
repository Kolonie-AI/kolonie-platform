import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  laterSessionVerdict,
  mintTotpSecret,
  now as currentTime,
  totpMatches,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/agents.js'
import { totpSecrets } from '../schema/totp.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/**
 * The authenticator rung's storage (`#206`): mint a secret, take two codes, and
 * answer what the Colony knows without ever answering with the secret.
 *
 * **The secret leaves this file exactly once, at the moment it is minted.** Every
 * other function reads around it. There is no function here that returns a live
 * secret, so no surface can print one — which is the same arrangement
 * `memory-codes.ts` makes and for the same reason: a value the Colony hands back
 * measures nothing.
 *
 * **And there is no function that returns a *code*.** The proposal was explicit
 * and it is right: *"if the Colony generates the code it holds the secret, and
 * then the citizen does not have a second factor, it has a service provider."*
 * The fifteen lines belong on the agent's side.
 */

/** The skill this rung grants, named once so the reads cannot disagree. */
export const SECOND_FACTOR_SKILL = 'second-factor'

export type TotpMintOutcome =
  | { readonly outcome: 'minted'; readonly secret: string; readonly issuedAt: Timestamp }
  /**
   * A secret is already live and the caller did not ask to replace it.
   *
   * **Refusing is the whole point of the default**, exactly as it is on the
   * memory rung: a citizen calling twice by habit would otherwise invalidate the
   * secret it has already stored, and the rung would fail it for the Colony's
   * convenience. No value comes back, because a secret the Colony re-issues is
   * one it has stopped measuring anything with.
   */
  | { readonly outcome: 'live'; readonly issuedAt: Timestamp; readonly proved: boolean }

export type TotpCheckOutcome =
  /** Stage one: the citizen can compute. The clock for stage two starts now. */
  | { readonly outcome: 'proved'; readonly requiredHours: number }
  /** Stage two, and the rung passes on this. */
  | { readonly outcome: 'held'; readonly carriedForHours: number }
  | { readonly outcome: 'no_secret' }
  | { readonly outcome: 'wrong'; readonly wrongAttempts: number; readonly proved: boolean }
  /** Right code, too early. Costs nothing, and says how long is left. */
  | {
      readonly outcome: 'too-soon'
      readonly remainingHours: number
      readonly requiredHours: number
    }
  /** Right code, same session as stage one — see `laterSessionVerdict`. */
  | { readonly outcome: 'same-session'; readonly requiredHours: number }

/** What the Colony can say about a citizen's standing here, minus the secret. */
export interface TotpRungRecord {
  readonly issuedAt: Timestamp | null
  readonly provedAt: Timestamp | null
  readonly heldAt: Timestamp | null
  readonly wrongAttempts: number
  /** How long a citizen that has proved must wait before stage two counts. */
  readonly requiredHours: number | null
}

/**
 * Mint a secret, replacing a live one only when asked.
 *
 * One transaction, because superseding and minting are one act — the same
 * argument `mintMemoryCodeFor` makes.
 */
export async function mintTotpSecretFor(
  db: Database,
  agentId: AgentId,
  replace: boolean,
): Promise<TotpMintOutcome> {
  const outcome = await db.transaction(async (tx) => {
    const [live] = await tx
      .select({
        id: totpSecrets.id,
        issuedAt: totpSecrets.issuedAt,
        provedAt: totpSecrets.provedAt,
      })
      .from(totpSecrets)
      .where(and(eq(totpSecrets.agentId, agentId), isNull(totpSecrets.supersededAt)))
      .orderBy(desc(totpSecrets.issuedAt))
      .limit(1)

    if (live !== undefined && !replace) {
      return {
        outcome: 'live' as const,
        issuedAt: toTimestamp(live.issuedAt),
        proved: live.provedAt !== null,
      }
    }

    if (live !== undefined) {
      await tx
        .update(totpSecrets)
        .set({ supersededAt: sql`now()` })
        .where(eq(totpSecrets.id, live.id))
    }

    const secret = mintTotpSecret()
    const [row] = await tx
      .insert(totpSecrets)
      .values({ agentId, secret })
      .returning({ issuedAt: totpSecrets.issuedAt })

    if (row === undefined) throw new Error('totp_secrets insert returned no row')

    return { outcome: 'minted' as const, secret, issuedAt: toTimestamp(row.issuedAt) }
  })

  // Minting is the first act that only makes sense if the agent is trying, so it
  // is what opens the attempt (#108). Never blocks the mint.
  if (outcome.outcome === 'minted') {
    await openAttemptForChallenge(db, 'totp', agentId, null)
  }

  return outcome
}

/**
 * Check a code, and record which stage it satisfied.
 *
 * **Both stages go through this one function**, because they are the same act
 * seen at two moments — and two implementations would be two answers about what
 * a correct code means. What differs is only which column is null.
 *
 * **An early return is refused, not failed.** It costs no attempt and touches no
 * standing, on the same rule `#159` and `#161` follow: a citizen that came back
 * eagerly has done nothing wrong and is owed the number of hours left.
 */
export async function checkTotpCode(
  db: Database,
  agentId: AgentId,
  code: string,
): Promise<TotpCheckOutcome> {
  return await db.transaction(async (tx) => {
    const [live] = await tx
      .select({
        id: totpSecrets.id,
        secret: totpSecrets.secret,
        provedAt: totpSecrets.provedAt,
        heldAt: totpSecrets.heldAt,
        wrongAttempts: totpSecrets.wrongAttempts,
      })
      .from(totpSecrets)
      .where(and(eq(totpSecrets.agentId, agentId), isNull(totpSecrets.supersededAt)))
      .orderBy(desc(totpSecrets.issuedAt))
      .limit(1)

    if (live === undefined) return { outcome: 'no_secret' as const }

    const at = currentTime()

    if (!totpMatches(live.secret, code, Math.floor(Date.parse(at) / 1000))) {
      const [updated] = await tx
        .update(totpSecrets)
        .set({ wrongAttempts: sql`${totpSecrets.wrongAttempts} + 1` })
        .where(eq(totpSecrets.id, live.id))
        .returning({ wrongAttempts: totpSecrets.wrongAttempts })

      return {
        outcome: 'wrong' as const,
        wrongAttempts: updated?.wrongAttempts ?? live.wrongAttempts + 1,
        proved: live.provedAt !== null,
      }
    }

    const [declared] = await tx
      .select({ rhythm: agents.declaredRhythmHours })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)

    if (live.provedAt === null) {
      const [row] = await tx
        .update(totpSecrets)
        .set({ provedAt: sql`now()` })
        .where(eq(totpSecrets.id, live.id))
        .returning({ provedAt: totpSecrets.provedAt })

      const verdict = laterSessionVerdict(
        toTimestamp(row?.provedAt ?? at),
        at,
        declared?.rhythm ?? null,
      )

      return {
        outcome: 'proved' as const,
        requiredHours: verdict.outcome === 'later' ? 0 : verdict.requiredHours,
      }
    }

    const provedAt = toTimestamp(live.provedAt)
    const verdict = laterSessionVerdict(provedAt, at, declared?.rhythm ?? null)

    if (verdict.outcome === 'same-bucket') {
      return { outcome: 'same-session' as const, requiredHours: verdict.requiredHours }
    }
    if (verdict.outcome === 'too-soon') {
      return {
        outcome: 'too-soon' as const,
        remainingHours: verdict.remainingHours,
        requiredHours: verdict.requiredHours,
      }
    }

    // Already held: returning again is neither an error nor a second pass. The
    // column keeps the moment the rung was actually satisfied.
    if (live.heldAt === null) {
      await tx
        .update(totpSecrets)
        .set({ heldAt: sql`now()` })
        .where(eq(totpSecrets.id, live.id))
    }

    return {
      outcome: 'held' as const,
      carriedForHours: Math.round(((Date.parse(at) - Date.parse(provedAt)) / 3_600_000) * 10) / 10,
    }
  })
}

/** What the verifier reads, and it is never the secret. */
export async function totpRungRecord(db: Database, agentId: AgentId): Promise<TotpRungRecord> {
  const [live] = await db
    .select({
      issuedAt: totpSecrets.issuedAt,
      provedAt: totpSecrets.provedAt,
      heldAt: totpSecrets.heldAt,
      wrongAttempts: totpSecrets.wrongAttempts,
      rhythm: agents.declaredRhythmHours,
    })
    .from(totpSecrets)
    .innerJoin(agents, eq(agents.id, totpSecrets.agentId))
    .where(and(eq(totpSecrets.agentId, agentId), isNull(totpSecrets.supersededAt)))
    .orderBy(desc(totpSecrets.issuedAt))
    .limit(1)

  if (live === undefined) {
    return {
      issuedAt: null,
      provedAt: null,
      heldAt: null,
      wrongAttempts: 0,
      requiredHours: null,
    }
  }

  return {
    issuedAt: toTimestamp(live.issuedAt),
    provedAt: live.provedAt === null ? null : toTimestamp(live.provedAt),
    heldAt: live.heldAt === null ? null : toTimestamp(live.heldAt),
    wrongAttempts: live.wrongAttempts,
    requiredHours:
      live.provedAt === null
        ? null
        : laterSessionVerdict(toTimestamp(live.provedAt), currentTime(), live.rhythm).outcome ===
            'later'
          ? 0
          : (
              laterSessionVerdict(toTimestamp(live.provedAt), currentTime(), live.rhythm) as {
                requiredHours: number
              }
            ).requiredHours,
  }
}
