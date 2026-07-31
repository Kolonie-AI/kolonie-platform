import { desc, eq, sql } from 'drizzle-orm'
import {
  drawImageConstraints,
  imagePromptFor,
  ImageConstraintsSchema,
  type AgentId,
  type ImageConstraints,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { imageChallenges } from '../schema/image.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/**
 * An hour, which is the Colony's willingness to be asked about a specification
 * rather than a bound on the agent's work — see the column's own comment.
 */
export const IMAGE_CHALLENGE_LIFETIME_MS = 60 * 60 * 1000

export interface ImageChallengeState {
  readonly constraints: ImageConstraints
  readonly prompt: string
  readonly expiresAt: Timestamp
}

/**
 * Draw a specification for this agent and record it.
 *
 * **Minting again replaces nothing and revokes nothing.** The row is inserted,
 * and {@link latestImageChallenge} reads the newest unexpired one, which is the
 * same arrangement every other challenge table uses. An agent that mints twice
 * has two specifications on record and its image is checked against the second —
 * so the useful thing to tell it is that the prompt it is working from is stale,
 * rather than silently grading an image against a picture nobody asked for.
 */
export async function mintImageChallenge(
  db: Database,
  agentId: AgentId,
  random?: () => number,
): Promise<ImageChallengeState> {
  const constraints = drawImageConstraints(random)
  const prompt = imagePromptFor(constraints)
  const expiresAt = new Date(Date.now() + IMAGE_CHALLENGE_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(imageChallenges)
    .values({ agentId, ...constraints, prompt, expiresAt })
    .returning({ expiresAt: imageChallenges.expiresAt })

  if (row === undefined) throw new Error('image_challenges insert returned no row')

  // Minting is the first act that only makes sense if the agent is trying, so it
  // is what opens the attempt (#108). Never blocks the mint — see
  // `openAttemptForChallenge`.
  await openAttemptForChallenge(db, 'image', agentId, toTimestamp(row.expiresAt))

  return { constraints, prompt, expiresAt: toTimestamp(row.expiresAt) }
}

/**
 * The specification this agent is currently working to, or `null`.
 *
 * **Expiry is decided by Postgres rather than by the caller**, the same way the
 * open-token reads are: two processes with two clocks would otherwise disagree
 * about whether the same row is still live, and the one that matters is the one
 * the row is stored in.
 *
 * The constraints are parsed on the way out rather than trusted. They are
 * `text` columns, so a row written by an older build — or by hand — could carry
 * a colour the palette no longer has, and a verifier asking a vision model about
 * `chartreuse` would get an answer it should never have been able to ask for.
 */
export async function latestImageChallenge(
  db: Database,
  agentId: AgentId,
): Promise<ImageChallengeState | null> {
  const [row] = await db
    .select({
      background: imageChallenges.background,
      shape: imageChallenges.shape,
      shapeColor: imageChallenges.shapeColor,
      position: imageChallenges.position,
      secondary: imageChallenges.secondary,
      prompt: imageChallenges.prompt,
      expiresAt: imageChallenges.expiresAt,
    })
    .from(imageChallenges)
    .where(sql`${imageChallenges.agentId} = ${agentId} and ${imageChallenges.expiresAt} > now()`)
    .orderBy(desc(imageChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  const constraints = ImageConstraintsSchema.safeParse({
    background: row.background,
    shape: row.shape,
    shapeColor: row.shapeColor,
    position: row.position,
    secondary: row.secondary,
  })
  if (!constraints.success) return null

  return {
    constraints: constraints.data,
    prompt: row.prompt,
    expiresAt: toTimestamp(row.expiresAt),
  }
}

/** When this agent's most recent specification runs out, live or not. */
export async function lastImageChallengeExpiry(
  db: Database,
  agentId: AgentId,
): Promise<Timestamp | null> {
  const [row] = await db
    .select({ expiresAt: imageChallenges.expiresAt })
    .from(imageChallenges)
    .where(eq(imageChallenges.agentId, agentId))
    .orderBy(desc(imageChallenges.expiresAt))
    .limit(1)

  return row === undefined ? null : toTimestamp(row.expiresAt)
}
