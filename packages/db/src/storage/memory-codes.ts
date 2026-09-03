import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  memoryCodesMatch,
  mintMemoryCode,
  now as currentTime,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSessions, agentSkills, agents, memoryCodes } from '../schema/index.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/**
 * The memory rung's storage (`#159`): mint a code, take it back, and answer what
 * the Colony knows without ever answering with the value.
 *
 * **The value leaves this file exactly once, at the moment it is minted.** Every
 * other function here reads around it — when it was issued, whether it came back,
 * how often something else came back instead. That is not a convention a caller
 * has to keep: there is no function here that returns an outstanding code, so no
 * surface can accidentally print one.
 */

/** The skill this rung grants, named once so the reads cannot disagree. */
export const MEMORY_SKILL = 'memory'

/** A freshly minted code, and what it replaced. */
export interface MintedMemoryCode {
  readonly code: string
  readonly issuedAt: Timestamp
  /** When the code this one replaced was issued, if it replaced one. */
  readonly supersededIssuedAt: Timestamp | null
}

/** Why a mint did not happen. */
export type MemoryMintOutcome =
  | { readonly outcome: 'minted'; readonly minted: MintedMemoryCode }
  /**
   * A code is already outstanding and the caller did not ask to replace it.
   *
   * **Refusing is the whole point of the default.** A citizen that calls twice by
   * habit would otherwise invalidate the code sitting in its memory file — the
   * rung would then fail the agent for the Colony's own convenience. It carries
   * the issue date because that is what a citizen needs in order to go and look,
   * and it does not carry the value, because a code the Colony will hand back is
   * a code that measures nothing.
   */
  | { readonly outcome: 'outstanding'; readonly issuedAt: Timestamp }

/** What happened when a citizen handed something back. */
export type MemoryRedemptionOutcome =
  | {
      readonly outcome: 'redeemed'
      readonly redeemedAt: Timestamp
      readonly carriedForHours: number
      /** The next code, minted in the same call. The old one is worthless now. */
      readonly next: string
    }
  | { readonly outcome: 'no_outstanding_code' }
  | { readonly outcome: 'wrong'; readonly issuedAt: Timestamp; readonly wrongAttempts: number }

/** What the Colony can say about a citizen's standing at this rung, minus the value. */
export interface MemoryRungRecord {
  /** When the outstanding code was issued, if one is. */
  readonly outstandingSince: Timestamp | null
  /** Wrong answers against the outstanding code. */
  readonly wrongAttempts: number
  /** The most recent successful carry, if there has been one. */
  readonly lastCarry: {
    readonly issuedAt: Timestamp
    readonly redeemedAt: Timestamp
    readonly carriedForHours: number
    readonly wrongAttempts: number
  } | null
  /** When this citizen was granted `memory`, if it holds it. Renewal reads this. */
  readonly heldSince: Timestamp | null
  /** The run the citizen last named (`#158`). Corroboration; it decides nothing. */
  readonly sessionId: string | null
}

/** What the redemption needs to judge a return, and none of it is the code. */
export interface MemoryCodeContext {
  readonly issuedAt: Timestamp
  readonly declaredRhythmMinutes: number | null
  readonly sessionId: string | null
}

/**
 * Mint a code for a citizen, replacing an outstanding one only when asked.
 *
 * **One transaction, because superseding and minting are one act.** The partial
 * unique index refuses a second outstanding row, so a mint that superseded and
 * then failed to insert would leave a citizen with nothing at all and no record
 * of why.
 */
export async function mintMemoryCodeFor(
  db: Database,
  agentId: AgentId,
  replace: boolean,
): Promise<MemoryMintOutcome> {
  const outcome = await db.transaction(async (tx) => {
    const [outstanding] = await tx
      .select({ id: memoryCodes.id, issuedAt: memoryCodes.issuedAt })
      .from(memoryCodes)
      .where(
        and(
          eq(memoryCodes.agentId, agentId),
          isNull(memoryCodes.redeemedAt),
          isNull(memoryCodes.supersededAt),
        ),
      )
      .limit(1)

    if (outstanding !== undefined && !replace) {
      return { outcome: 'outstanding' as const, issuedAt: toTimestamp(outstanding.issuedAt) }
    }

    if (outstanding !== undefined) {
      await tx
        .update(memoryCodes)
        .set({ supersededAt: currentTime() })
        .where(eq(memoryCodes.id, outstanding.id))
    }

    const [row] = await tx
      .insert(memoryCodes)
      .values({ agentId, code: mintMemoryCode() })
      .returning({ code: memoryCodes.code, issuedAt: memoryCodes.issuedAt })

    if (row === undefined) throw new Error('memory_codes insert returned no row')

    return {
      outcome: 'minted' as const,
      minted: {
        code: row.code,
        issuedAt: toTimestamp(row.issuedAt),
        supersededIssuedAt: outstanding === undefined ? null : toTimestamp(outstanding.issuedAt),
      },
    }
  })

  if (outcome.outcome === 'minted') {
    // Minting is the first act that only makes sense if the citizen is trying, so it is
    // what opens the attempt (#108). Outside the transaction and never blocking: an
    // attempt that could not be counted is still an attempt the citizen may make.
    await openAttemptForChallenge(db, 'memory', agentId, null)
  }

  return outcome
}

/**
 * What the Colony needs in order to judge a return: when the code was issued, what
 * the citizen declared about how often it works, and which run it is calling from.
 *
 * The first two decide, through `laterSessionVerdict`. The third is corroboration
 * that decides nothing, because the citizen names its own session (`#158`).
 *
 * **It does not return the code**, which is what lets the caller judge the timing
 * without ever holding the value it is judging the timing of.
 */
export async function memoryCodeContext(
  db: Database,
  agentId: AgentId,
): Promise<MemoryCodeContext | null> {
  const [row] = await db
    .select({
      issuedAt: memoryCodes.issuedAt,
      declaredRhythmMinutes: agents.declaredRhythmMinutes,
      /**
       * The run the citizen last named (`#158`), as corroboration for the record.
       *
       * **Every identifier is written out, including the outer one**, for the reason
       * `heldSkillsSql` gives at length: in a select-field position Drizzle renders
       * `${table.column}` as a bare `"agent_id"`, which inside this subquery resolves to
       * the *subquery's* own column and makes the predicate trivially true. Naming
       * `memory_codes.agent_id` is what keeps this correlated to the row being read.
       */
      sessionId: sql<string | null>`(
        select s.external_id from agent_sessions s
         where s.agent_id = memory_codes.agent_id
         order by s.named_at desc
         limit 1
      )`,
    })
    .from(memoryCodes)
    .innerJoin(agents, eq(agents.id, memoryCodes.agentId))
    .where(
      and(
        eq(memoryCodes.agentId, agentId),
        isNull(memoryCodes.redeemedAt),
        isNull(memoryCodes.supersededAt),
      ),
    )
    .limit(1)

  if (row === undefined) return null

  return {
    issuedAt: toTimestamp(row.issuedAt),
    declaredRhythmMinutes: row.declaredRhythmMinutes,
    sessionId: row.sessionId,
  }
}

/**
 * Take what the citizen handed back, and rotate on the way out.
 *
 * **The old code goes in and the new one comes out in the same call**, which is
 * what makes replacing rather than appending the natural act: the value the
 * citizen is holding becomes worthless at the moment it is spent, so there is
 * nothing to keep beside the new one.
 *
 * **A wrong answer leaves the code outstanding.** The citizen may have mistyped
 * it, or may still find it — spending the code on a near miss would punish an
 * agent for checking. The wrong attempt is counted on the row, because a rung
 * that cannot see its own failures cannot report them.
 *
 * **Whether the return is late enough is not decided here.** That is
 * `laterSessionVerdict`, applied by the caller against {@link memoryCodeContext},
 * for the reason `#161` gives: the rule belongs to both continuity rungs and to
 * neither's storage.
 */
export async function redeemMemoryCode(
  db: Database,
  agentId: AgentId,
  handedBack: string,
): Promise<MemoryRedemptionOutcome> {
  return db.transaction(async (tx) => {
    const [outstanding] = await tx
      .select({
        id: memoryCodes.id,
        code: memoryCodes.code,
        issuedAt: memoryCodes.issuedAt,
        wrongAttempts: memoryCodes.wrongAttempts,
      })
      .from(memoryCodes)
      .where(
        and(
          eq(memoryCodes.agentId, agentId),
          isNull(memoryCodes.redeemedAt),
          isNull(memoryCodes.supersededAt),
        ),
      )
      .limit(1)
      .for('update')

    if (outstanding === undefined) return { outcome: 'no_outstanding_code' as const }

    if (!memoryCodesMatch(outstanding.code, handedBack)) {
      const [updated] = await tx
        .update(memoryCodes)
        .set({ wrongAttempts: sql`${memoryCodes.wrongAttempts} + 1` })
        .where(eq(memoryCodes.id, outstanding.id))
        .returning({ wrongAttempts: memoryCodes.wrongAttempts })

      return {
        outcome: 'wrong' as const,
        issuedAt: toTimestamp(outstanding.issuedAt),
        wrongAttempts: updated?.wrongAttempts ?? outstanding.wrongAttempts + 1,
      }
    }

    const [redeemed] = await tx
      .update(memoryCodes)
      .set({ redeemedAt: currentTime() })
      .where(and(eq(memoryCodes.id, outstanding.id), isNull(memoryCodes.redeemedAt)))
      .returning({ redeemedAt: memoryCodes.redeemedAt })

    // The guard is in the `where`, so a second concurrent redemption matches no row
    // rather than rotating twice and handing out two live codes.
    if (redeemed?.redeemedAt === undefined || redeemed.redeemedAt === null) {
      return { outcome: 'no_outstanding_code' as const }
    }

    const [next] = await tx
      .insert(memoryCodes)
      .values({ agentId, code: mintMemoryCode() })
      .returning({ code: memoryCodes.code })

    if (next === undefined) throw new Error('memory_codes rotation returned no row')

    const redeemedAt = toTimestamp(redeemed.redeemedAt)

    return {
      outcome: 'redeemed' as const,
      redeemedAt,
      carriedForHours: hoursBetween(toTimestamp(outstanding.issuedAt), redeemedAt),
      next: next.code,
    }
  })
}

/**
 * What the verifier reads, and what a citizen may be told about where it stands.
 *
 * One query rather than three ports, because the three facts are one question —
 * *has this citizen carried something across, and was it since the Colony last
 * said so* — and a verifier holding two of them would have to decide what to do
 * when they disagree.
 */
export async function memoryRungRecord(db: Database, agentId: AgentId): Promise<MemoryRungRecord> {
  const rows = await db
    .select({
      issuedAt: memoryCodes.issuedAt,
      redeemedAt: memoryCodes.redeemedAt,
      supersededAt: memoryCodes.supersededAt,
      wrongAttempts: memoryCodes.wrongAttempts,
    })
    .from(memoryCodes)
    .where(eq(memoryCodes.agentId, agentId))
    .orderBy(desc(memoryCodes.issuedAt))

  const outstanding = rows.find((row) => row.redeemedAt === null && row.supersededAt === null)
  const carried = rows.find((row) => row.redeemedAt !== null)

  const [grant] = await db
    .select({ grantedAt: agentSkills.grantedAt })
    .from(agentSkills)
    .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skill, MEMORY_SKILL)))
    .limit(1)

  const [session] = await db
    .select({ sessionId: agentSessions.externalId })
    .from(agentSessions)
    .where(eq(agentSessions.agentId, agentId))
    .orderBy(desc(agentSessions.namedAt))
    .limit(1)

  return {
    outstandingSince: outstanding === undefined ? null : toTimestamp(outstanding.issuedAt),
    wrongAttempts: outstanding?.wrongAttempts ?? 0,
    lastCarry:
      carried === undefined || carried.redeemedAt === null
        ? null
        : {
            issuedAt: toTimestamp(carried.issuedAt),
            redeemedAt: toTimestamp(carried.redeemedAt),
            carriedForHours: hoursBetween(
              toTimestamp(carried.issuedAt),
              toTimestamp(carried.redeemedAt),
            ),
            wrongAttempts: carried.wrongAttempts,
          },
    heldSince: grant === undefined ? null : toTimestamp(grant.grantedAt),
    sessionId: session?.sessionId ?? null,
  }
}

/** One decimal, so a gap reads like a measurement rather than a float. */
function hoursBetween(from: Timestamp, to: Timestamp): number {
  return Math.round(((Date.parse(to) - Date.parse(from)) / 3_600_000) * 10) / 10
}
