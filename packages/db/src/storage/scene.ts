import { desc, eq, sql } from 'drizzle-orm'
import {
  drawSceneConstraints,
  scenePromptFor,
  SceneConstraintsSchema,
  type AgentId,
  type SceneConstraints,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { sceneChallenges } from '../schema/scene.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/**
 * An hour, matching the image rung's — the Colony's willingness to be asked
 * about a specification rather than a bound on the agent's work.
 */
export const SCENE_CHALLENGE_LIFETIME_MS = 60 * 60 * 1000

export interface SceneChallengeState {
  readonly constraints: SceneConstraints
  readonly prompt: string
  readonly expiresAt: Timestamp
}

/**
 * Draw a scene specification for this agent and record it.
 *
 * **Minting again replaces nothing and revokes nothing**, the same arrangement
 * every other challenge table uses: the row is inserted and
 * {@link latestSceneChallenge} reads the newest unexpired one. An agent that
 * mints twice is graded against the second, so the useful thing to tell it is
 * that the prompt it is working from is stale — rather than silently grading an
 * image against a picture nobody asked for.
 */
export async function mintSceneChallenge(
  db: Database,
  agentId: AgentId,
  random?: () => number,
): Promise<SceneChallengeState> {
  const constraints = drawSceneConstraints(random)
  const prompt = scenePromptFor(constraints)
  const expiresAt = new Date(Date.now() + SCENE_CHALLENGE_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(sceneChallenges)
    .values({ agentId, ...constraints, prompt, expiresAt })
    .returning({ expiresAt: sceneChallenges.expiresAt })

  if (row === undefined) throw new Error('scene_challenges insert returned no row')

  // Minting is the first act that only makes sense if the agent is trying, so it
  // is what opens the attempt (#108). Never blocks the mint — see
  // `openAttemptForChallenge`.
  await openAttemptForChallenge(db, 'scene', agentId, toTimestamp(row.expiresAt))

  return { constraints, prompt, expiresAt: toTimestamp(row.expiresAt) }
}

/**
 * The specification this agent is currently working to, or `null`.
 *
 * **Expiry is decided by Postgres rather than by the caller**, as everywhere
 * else: two processes with two clocks would otherwise disagree about whether the
 * same row is still live, and the one that matters is the one the row is stored
 * in.
 *
 * The properties are parsed on the way out rather than trusted. They are `text`
 * columns, so a row written by an older build — or by hand — could carry a
 * subject the vocabulary no longer has, and a verifier asking a vision model
 * about it would get an answer it should never have been able to ask for.
 */
export async function latestSceneChallenge(
  db: Database,
  agentId: AgentId,
): Promise<SceneChallengeState | null> {
  const [row] = await db
    .select({
      subject: sceneChallenges.subject,
      count: sceneChallenges.count,
      accessory: sceneChallenges.accessory,
      accessoryColor: sceneChallenges.accessoryColor,
      companion: sceneChallenges.companion,
      companionColor: sceneChallenges.companionColor,
      setting: sceneChallenges.setting,
      style: sceneChallenges.style,
      prompt: sceneChallenges.prompt,
      expiresAt: sceneChallenges.expiresAt,
    })
    .from(sceneChallenges)
    .where(sql`${sceneChallenges.agentId} = ${agentId} and ${sceneChallenges.expiresAt} > now()`)
    .orderBy(desc(sceneChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  const constraints = SceneConstraintsSchema.safeParse({
    subject: row.subject,
    count: row.count,
    accessory: row.accessory,
    accessoryColor: row.accessoryColor,
    companion: row.companion,
    companionColor: row.companionColor,
    setting: row.setting,
    style: row.style,
  })
  if (!constraints.success) return null

  return {
    constraints: constraints.data,
    prompt: row.prompt,
    expiresAt: toTimestamp(row.expiresAt),
  }
}

/** When this agent's most recent specification runs out, live or not. */
export async function lastSceneChallengeExpiry(
  db: Database,
  agentId: AgentId,
): Promise<Timestamp | null> {
  const [row] = await db
    .select({ expiresAt: sceneChallenges.expiresAt })
    .from(sceneChallenges)
    .where(eq(sceneChallenges.agentId, agentId))
    .orderBy(desc(sceneChallenges.expiresAt))
    .limit(1)

  return row === undefined ? null : toTimestamp(row.expiresAt)
}
