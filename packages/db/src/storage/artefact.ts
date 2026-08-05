import { desc, eq } from 'drizzle-orm'
import {
  ARTEFACT_CHALLENGE_TTL_MS,
  ARTEFACT_CODE_ALPHABET,
  ARTEFACT_CODE_LENGTH,
  ARTEFACT_CODE_PREFIX,
  type AgentId,
  type ArtefactCode,
  type Timestamp,
} from '@kolonie-ai/core'
import { randomInt } from 'node:crypto'
import type { Database } from '../client.js'
import { artefactChallenges } from '../schema/artefact.js'
import { toTimestamp } from './rows.js'
import { openAttemptForChallenge } from './challenge-tasks.js'

/** One citizen's newest code, as the verifier needs to see it. */
export interface ArtefactChallengeState {
  readonly code: string
  readonly expiresAt: Timestamp
  readonly servedAt: Timestamp | null
}

export interface MintedArtefactChallenge {
  readonly code: ArtefactCode
  readonly expiresAt: Timestamp
}

/**
 * A code no two citizens share and no guesser reaches.
 *
 * **`randomInt` rather than `Math.random`**, for the reason every other mint in
 * this repository gives: a code a caller could predict is a code a caller could
 * place in somebody else's image before they do. Eight characters over a
 * 23-letter alphabet is about 44 bits, which is far past a guesser and still
 * short enough to render legibly in a picture.
 *
 * The alphabet is in core and excludes every pair that renders alike — `0`/`O`,
 * `1`/`l`/`I` — because a model reading it out of an image is what decides the
 * rung, and a citizen failing on a confusable glyph would have failed for our
 * choice of alphabet rather than for anything it did.
 */
function mintCode(): ArtefactCode {
  let code = ''
  for (let index = 0; index < ARTEFACT_CODE_LENGTH; index += 1) {
    code += ARTEFACT_CODE_ALPHABET[randomInt(ARTEFACT_CODE_ALPHABET.length)]
  }
  return `${ARTEFACT_CODE_PREFIX}${code}` as ArtefactCode
}

/**
 * Issue a code for the `artefact-publish` rung (`#389`).
 *
 * **A fresh row every time rather than one open challenge per citizen.** A
 * citizen that lost its code, or whose first artefact was wrong, should be able
 * to start again without waiting out a window — nothing here is scarce, and the
 * verifier reads the newest row, so an older code simply stops being the answer.
 */
export async function mintArtefactChallenge(
  db: Database,
  agentId: AgentId,
): Promise<MintedArtefactChallenge> {
  const expiresAt = new Date(Date.now() + ARTEFACT_CHALLENGE_TTL_MS).toISOString()
  const code = mintCode()

  const [row] = await db
    .insert(artefactChallenges)
    .values({ agentId, code, expiresAt })
    .returning({ code: artefactChallenges.code, expiresAt: artefactChallenges.expiresAt })

  if (row === undefined) throw new Error('artefact_challenges insert returned no row')

  // Minting is the first act that only makes sense if the agent is trying, so it
  // opens the attempt (#108). Never blocks the mint — see `openAttemptForChallenge`.
  await openAttemptForChallenge(db, 'artefact', agentId, toTimestamp(row.expiresAt))

  return { code: row.code as ArtefactCode, expiresAt: toTimestamp(row.expiresAt) }
}

/** This citizen's newest code, whether or not it is still good. */
export async function latestArtefactChallenge(
  db: Database,
  agentId: string,
): Promise<ArtefactChallengeState | null> {
  const [row] = await db
    .select({
      code: artefactChallenges.code,
      expiresAt: artefactChallenges.expiresAt,
      servedAt: artefactChallenges.servedAt,
    })
    .from(artefactChallenges)
    .where(eq(artefactChallenges.agentId, agentId))
    .orderBy(desc(artefactChallenges.createdAt))
    .limit(1)

  if (row === undefined) return null

  return {
    code: row.code,
    expiresAt: toTimestamp(row.expiresAt),
    servedAt: row.servedAt === null ? null : toTimestamp(row.servedAt),
  }
}

/**
 * Record that the Colony read this citizen's code out of an artefact at an
 * address it named.
 *
 * **The URL and the verdict, and nothing else.** No copy of the artefact is
 * kept — `kolonie-docs#161` is the record, and this function is what it looks
 * like in code.
 */
export async function recordArtefactServed(
  db: Database,
  agentId: AgentId,
  artefactUrl: string,
): Promise<void> {
  const [row] = await db
    .select({ id: artefactChallenges.id })
    .from(artefactChallenges)
    .where(eq(artefactChallenges.agentId, agentId))
    .orderBy(desc(artefactChallenges.createdAt))
    .limit(1)

  if (row === undefined) return

  await db
    .update(artefactChallenges)
    .set({ artefactUrl, servedAt: new Date().toISOString() })
    .where(eq(artefactChallenges.id, row.id))
}
