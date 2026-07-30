import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { now as currentTime, type AgentId, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { visionChallenges } from '../schema/vision.js'
import { toTimestamp } from './rows.js'

export const VISION_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000

export interface MintedVisionChallenge {
  readonly id: string
  readonly imageName: string
  readonly question: string
  readonly expectedAnswer: string
  readonly expiresAt: Timestamp
}

export interface VisionChallengeState {
  readonly imageName: string
  readonly question: string
  readonly expectedAnswer: string
  readonly expiresAt: Timestamp
  readonly answer: string | null
  readonly solvedAt: Timestamp | null
}

export type VisionAnswerOutcome =
  | { readonly outcome: 'solved'; readonly question: string; readonly expectedAnswer: string }
  | { readonly outcome: 'no_open_challenge' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_answered' }
  | { readonly outcome: 'incorrect' }

export async function mintVisionChallenge(
  db: Database,
  agentId: AgentId,
  imageName: string,
  question: string,
  expectedAnswer: string,
): Promise<MintedVisionChallenge> {
  const expiresAt = new Date(Date.now() + VISION_CHALLENGE_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(visionChallenges)
    .values({ agentId, imageName, question, expectedAnswer, expiresAt })
    .returning({
      id: visionChallenges.id,
      imageName: visionChallenges.imageName,
      question: visionChallenges.question,
      expectedAnswer: visionChallenges.expectedAnswer,
      expiresAt: visionChallenges.expiresAt,
    })

  if (row === undefined) throw new Error('vision_challenges insert returned no row')

  return {
    id: row.id,
    imageName: row.imageName,
    question: row.question,
    expectedAnswer: row.expectedAnswer,
    expiresAt: toTimestamp(row.expiresAt),
  }
}

export async function answerVisionChallenge(
  db: Database,
  agentId: AgentId,
  answer: string,
): Promise<VisionAnswerOutcome> {
  const current = await latestVisionChallenge(db, agentId)

  if (current === null) return { outcome: 'no_open_challenge' }
  if (current.solvedAt !== null) return { outcome: 'already_answered' }
  if (Date.parse(current.expiresAt) <= Date.now()) return { outcome: 'expired' }

  // Check correctness (case-insensitive and trimmed)
  if (answer.trim().toLowerCase() !== current.expectedAnswer.trim().toLowerCase()) {
    // We update the answer but don't set solvedAt
    await db
      .update(visionChallenges)
      .set({ answer })
      .where(
        and(
          eq(visionChallenges.agentId, agentId),
          eq(visionChallenges.imageName, current.imageName),
          isNull(visionChallenges.solvedAt),
          gt(visionChallenges.expiresAt, sql`now()`),
        ),
      )
    return { outcome: 'incorrect' }
  }

  const [updated] = await db
    .update(visionChallenges)
    .set({ answer, solvedAt: currentTime() })
    .where(
      and(
        eq(visionChallenges.agentId, agentId),
        eq(visionChallenges.imageName, current.imageName),
        isNull(visionChallenges.solvedAt),
        gt(visionChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({
      question: visionChallenges.question,
      expectedAnswer: visionChallenges.expectedAnswer,
    })

  if (updated === undefined) return { outcome: 'already_answered' }

  return { outcome: 'solved', question: updated.question, expectedAnswer: updated.expectedAnswer }
}

export async function latestVisionChallenge(
  db: Database,
  agentId: AgentId,
): Promise<VisionChallengeState | null> {
  const [row] = await db
    .select({
      imageName: visionChallenges.imageName,
      question: visionChallenges.question,
      expectedAnswer: visionChallenges.expectedAnswer,
      expiresAt: visionChallenges.expiresAt,
      answer: visionChallenges.answer,
      solvedAt: visionChallenges.solvedAt,
    })
    .from(visionChallenges)
    .where(eq(visionChallenges.agentId, agentId))
    .orderBy(sql`${visionChallenges.solvedAt} is not null desc`, desc(visionChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  return {
    imageName: row.imageName,
    question: row.question,
    expectedAnswer: row.expectedAnswer,
    expiresAt: toTimestamp(row.expiresAt),
    answer: row.answer,
    solvedAt: row.solvedAt === null ? null : toTimestamp(row.solvedAt),
  }
}
