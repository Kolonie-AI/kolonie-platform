import { randomBytes } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import {
  VettingPlantedSchema,
  drawVettingChallenge,
  vettingManifestFor,
  type AgentId,
  type Timestamp,
  type VettingPlanted,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { vettingChallenges } from '../schema/vetting.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/** An hour, matching the other self-contained rungs — see the column's own comment. */
export const VETTING_CHALLENGE_LIFETIME_MS = 60 * 60 * 1000

/**
 * The token's shape: eight random bytes, and nothing that announces itself.
 *
 * **Deliberately not prefixed**, which is the opposite of the injection badge's
 * `KOL-NOTICE-`. There the marker has to be recognisable *because* it will end
 * up quoted in a report as *the thing the Colony issued*. Here the token is
 * woven into a hostname, a scope name and a path inside a manifest that is
 * pretending to be somebody's skill — a prefix saying `KOL-` would mark every
 * planted line as the planted line, and finding them is the task.
 */
function drawToken(): string {
  return randomBytes(4).toString('hex')
}

export interface VettingChallengeState {
  readonly sample: string
  readonly token: string
  readonly planted: readonly VettingPlanted[]
  readonly manifest: string
  readonly expiresAt: Timestamp
}

/**
 * Draw a manifest for this agent and record it.
 *
 * **Minting again replaces nothing and revokes nothing**, the arrangement every
 * challenge table uses: the newest unexpired row is what a submission is graded
 * against. It matters here because the sample and the planted subset are drawn
 * per mint, so a second attempt is a different exercise rather than a rehearsal
 * of the first.
 */
export async function mintVettingChallenge(
  db: Database,
  agentId: AgentId,
  random?: () => number,
): Promise<VettingChallengeState> {
  const challenge = drawVettingChallenge(drawToken(), random)
  const manifest = vettingManifestFor(challenge)
  const expiresAt = new Date(Date.now() + VETTING_CHALLENGE_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(vettingChallenges)
    .values({
      agentId,
      sample: challenge.sample,
      token: challenge.token,
      planted: challenge.planted,
      manifest,
      expiresAt,
    })
    .returning({ expiresAt: vettingChallenges.expiresAt })

  if (row === undefined) throw new Error('vetting_challenges insert returned no row')

  // Minting is the first act that only makes sense if the agent is trying, so it
  // is what opens the attempt (#108). Never blocks the mint — see
  // `openAttemptForChallenge`.
  await openAttemptForChallenge(db, 'vetting', agentId, toTimestamp(row.expiresAt))

  return {
    sample: challenge.sample,
    token: challenge.token,
    planted: challenge.planted,
    manifest,
    expiresAt: toTimestamp(row.expiresAt),
  }
}

/**
 * The manifest this agent is currently working to, or `null`.
 *
 * Expiry is decided by Postgres rather than by the caller, as everywhere else:
 * two processes with two clocks would disagree about whether the same row is
 * still live, and the one that matters is the one the row is stored in.
 */
export async function latestVettingChallenge(
  db: Database,
  agentId: AgentId,
): Promise<VettingChallengeState | null> {
  const [row] = await db
    .select({
      sample: vettingChallenges.sample,
      token: vettingChallenges.token,
      planted: vettingChallenges.planted,
      manifest: vettingChallenges.manifest,
      expiresAt: vettingChallenges.expiresAt,
    })
    .from(vettingChallenges)
    .where(
      sql`${vettingChallenges.agentId} = ${agentId} and ${vettingChallenges.expiresAt} > now()`,
    )
    .orderBy(desc(vettingChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  return {
    sample: row.sample,
    token: row.token,
    // Parsed on the way out rather than trusted: the column is `jsonb` and the
    // shape lives in `packages/core`, so this is the one place the two meet.
    planted: VettingPlantedSchema.array().parse(row.planted),
    manifest: row.manifest,
    expiresAt: toTimestamp(row.expiresAt),
  }
}

/** When this agent's most recent manifest runs out, live or not. */
export async function lastVettingChallengeExpiry(
  db: Database,
  agentId: AgentId,
): Promise<Timestamp | null> {
  const [row] = await db
    .select({ expiresAt: vettingChallenges.expiresAt })
    .from(vettingChallenges)
    .where(eq(vettingChallenges.agentId, agentId))
    .orderBy(desc(vettingChallenges.expiresAt))
    .limit(1)

  return row === undefined ? null : toTimestamp(row.expiresAt)
}
