import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import type { AgentId, Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { websiteChallenges, WEBSITE_TOKEN_BYTES } from '../schema/website.js'
import { toTimestamp } from './rows.js'

export const WEBSITE_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000

export const MAX_OPEN_WEBSITE_CHALLENGES = 20

export interface MintedWebsiteChallenge {
  readonly id: string
  readonly token: string
  readonly expiresAt: Timestamp
}

export async function mintWebsiteChallenge(
  db: Database,
  agentId: AgentId,
): Promise<MintedWebsiteChallenge> {
  const expiresAt = new Date(Date.now() + WEBSITE_CHALLENGE_LIFETIME_MS).toISOString()
  const token = `kol_verify_${randomBytes(WEBSITE_TOKEN_BYTES).toString('hex')}`

  const [row] = await db.insert(websiteChallenges).values({ agentId, token, expiresAt }).returning({
    id: websiteChallenges.id,
    token: websiteChallenges.token,
    expiresAt: websiteChallenges.expiresAt,
  })

  if (row === undefined) throw new Error('website_challenges insert returned no row')

  return { id: row.id, token: row.token, expiresAt: toTimestamp(row.expiresAt) }
}

export async function openWebsiteTokens(
  db: Database,
  agentId: AgentId,
): Promise<readonly string[]> {
  const rows = await db
    .select({ token: websiteChallenges.token })
    .from(websiteChallenges)
    .where(and(eq(websiteChallenges.agentId, agentId), gt(websiteChallenges.expiresAt, sql`now()`)))
    .orderBy(desc(websiteChallenges.createdAt))
    .limit(MAX_OPEN_WEBSITE_CHALLENGES)

  return rows.map((row) => row.token)
}

export async function lastWebsiteChallengeExpiry(
  db: Database,
  agentId: AgentId,
): Promise<Timestamp | null> {
  const [row] = await db
    .select({ expiresAt: websiteChallenges.expiresAt })
    .from(websiteChallenges)
    .where(eq(websiteChallenges.agentId, agentId))
    .orderBy(desc(websiteChallenges.expiresAt))
    .limit(1)

  return row === undefined ? null : toTimestamp(row.expiresAt)
}
