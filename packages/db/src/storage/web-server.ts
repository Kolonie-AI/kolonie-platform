import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import {
  MAX_OPEN_WEB_SERVER_CHALLENGES,
  WEB_SERVER_CHALLENGE_LIFETIME_MS,
  WEB_SERVER_PATH_PREFIX,
  WEB_SERVER_PROBE_WINDOW_MS,
  WEB_SERVER_SEPARATION_MS,
  type AgentId,
  type WebServerChallenge,
  type WebServerProbe,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  webServerChallenges,
  WEB_SERVER_NONCE_BYTES,
  WEB_SERVER_PATH_BYTES,
} from '../schema/index.js'
import { openAttemptForChallenge } from './challenge-tasks.js'
import { toTimestamp } from './rows.js'

/**
 * The queries behind the `web-server` rung (#244).
 *
 * **The disclosure rule lives here and nowhere else**, which is the one thing to
 * know about this file: {@link probeFor} decides what a citizen may be told, and
 * every surface — the MCP tool, the route, the verifier's port — goes through it.
 * A second implementation of *which probe is live* is a second chance to disclose
 * the one the citizen was not supposed to have yet.
 */

/** One challenge, as anything outside this file sees it. */
export interface WebServerChallengeRow {
  readonly id: string
  readonly agentId: AgentId
  readonly origin: string
  readonly machineIsSolelyMine: boolean
  readonly firstPath: string
  readonly firstNonce: string
  readonly firstServedAt: string | null
  readonly secondPath: string
  readonly secondNonce: string
  readonly secondServedAt: string | null
  readonly createdAt: string
  readonly expiresAt: string
}

const aPath = (): string =>
  `${WEB_SERVER_PATH_PREFIX}${randomBytes(WEB_SERVER_PATH_BYTES).toString('hex')}`

const aNonce = (): string => randomBytes(WEB_SERVER_NONCE_BYTES).toString('hex')

/**
 * When the second probe becomes answerable, or `null` while the first has not been.
 *
 * Derived rather than stored: a column would be a second copy of
 * `firstServedAt + WEB_SERVER_SEPARATION_MS` that could disagree with it, and the
 * one thing this rung cannot afford to be wrong about is when the second probe
 * opens.
 */
export function secondOpensAt(row: WebServerChallengeRow): string | null {
  if (row.firstServedAt === null) return null
  return new Date(Date.parse(row.firstServedAt) + WEB_SERVER_SEPARATION_MS).toISOString()
}

/**
 * Which probe this citizen may answer right now, and what it must serve — or
 * `null` when the answer is *nothing, wait*.
 *
 * **This is the disclosure rule.** Three states produce `null`, and they are
 * different situations with the same correct answer:
 *
 * - the challenge has expired, so there is nothing to serve;
 * - the first probe was served and the separation has not elapsed, so the citizen
 *   should keep its server running and come back;
 * - both were served, so the rung is done.
 *
 * The caller distinguishes them from the row's own fields. What matters here is
 * that **the second path and nonce are never returned early**, because a citizen
 * holding both at once could prepare two static files and walk away — which is
 * precisely the thing this rung exists to rule out.
 */
export function probeFor(
  row: WebServerChallengeRow,
  now: number = Date.now(),
): {
  readonly which: WebServerProbe
  readonly path: string
  readonly nonce: string
  readonly answerBy: string
} | null {
  if (Date.parse(row.expiresAt) <= now) return null
  if (row.secondServedAt !== null) return null

  if (row.firstServedAt === null) {
    return {
      which: 'first',
      path: row.firstPath,
      nonce: row.firstNonce,
      /**
       * The window runs from *now*, not from when the challenge was minted.
       *
       * A citizen that mints a challenge, goes away, and comes back must find a
       * probe it can still answer — the alternative is a rung that punishes a slow
       * rhythm, which measures the citizen's schedule rather than its server. What
       * the window bounds is how long it may take *once it has been asked*, and
       * asking is reading this.
       */
      answerBy: new Date(now + WEB_SERVER_PROBE_WINDOW_MS).toISOString(),
    }
  }

  const opens = Date.parse(row.firstServedAt) + WEB_SERVER_SEPARATION_MS
  if (now < opens) return null

  return {
    which: 'second',
    path: row.secondPath,
    nonce: row.secondNonce,
    answerBy: new Date(now + WEB_SERVER_PROBE_WINDOW_MS).toISOString(),
  }
}

/** The row, rendered for a caller — with only the probe it is allowed to see. */
export function asChallenge(row: WebServerChallengeRow, now?: number): WebServerChallenge {
  return {
    challengeId: row.id,
    origin: row.origin,
    expiresAt: row.expiresAt,
    firstServed: row.firstServedAt !== null,
    probe: probeFor(row, now),
    secondOpensAt: secondOpensAt(row),
  }
}

/** What happened when a citizen asked for one. */
export type MintWebServerChallengeOutcome =
  | { readonly outcome: 'minted'; readonly row: WebServerChallengeRow }
  /**
   * The citizen already has one open, and it is returned rather than replaced.
   *
   * **Minting a second would reset the clock**, which is the one thing a citizen
   * halfway through this rung must not be able to do by accident: the separation
   * it has already waited out is most of the work.
   *
   * **By accident, and not on purpose** (`#717`). `replace` is how a citizen
   * asks for the reset deliberately, and it exists because the rule above locked
   * a citizen out of the rung entirely when its origin stopped answering: the
   * open challenge could never be completed, every fresh mint handed back the
   * dead one's probe, and waiting the challenge out was the only remedy. The
   * `origin` on this outcome is what a caller needs to say *the one you have is
   * for somewhere else*, which is the sentence that was missing.
   */
  | { readonly outcome: 'already-open'; readonly row: WebServerChallengeRow }
  /** Too many open at once. `website`'s ceiling, for its reason. */
  | { readonly outcome: 'too-many' }

/**
 * Mint one, or hand back the one already open.
 *
 * Both probes are written here and only one is ever disclosed — see the table's
 * comment for why that split exists.
 */
export async function mintWebServerChallenge(
  db: Database,
  input: {
    readonly agentId: AgentId
    readonly origin: string
    readonly machineIsSolelyMine: boolean
    /** Abandon the unfinished challenge and start over, clock and all (`#717`). */
    readonly replace?: boolean
  },
): Promise<MintWebServerChallengeOutcome> {
  const open = await openWebServerChallenges(db, input.agentId)

  const unfinished = open.find((row) => row.secondServedAt === null)
  if (unfinished !== undefined) {
    if (input.replace !== true) return { outcome: 'already-open', row: unfinished }

    /**
     * **Expired rather than deleted.** The row is the record of an attempt the
     * citizen made, and `openWebServerChallenges` filters on the deadline — so
     * setting it to now closes the challenge by the same rule everything else
     * here reads, and leaves the attempt legible afterwards. The same shape
     * `mintSmsReceiveChallenge` uses for its own replacement.
     */
    await db
      .update(webServerChallenges)
      .set({ expiresAt: new Date().toISOString() })
      .where(eq(webServerChallenges.id, unfinished.id))
  }

  // Counted after the replacement, so abandoning one and minting another cannot
  // be refused by a ceiling the abandonment has just made room under.
  const stillOpen = open.filter((row) => row.id !== unfinished?.id || input.replace !== true)
  if (stillOpen.length >= MAX_OPEN_WEB_SERVER_CHALLENGES) return { outcome: 'too-many' }

  const expiresAt = new Date(Date.now() + WEB_SERVER_CHALLENGE_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(webServerChallenges)
    .values({
      agentId: input.agentId,
      origin: input.origin,
      machineIsSolelyMine: input.machineIsSolelyMine,
      firstPath: aPath(),
      firstNonce: aNonce(),
      secondPath: aPath(),
      secondNonce: aNonce(),
      expiresAt,
    })
    .returning()

  if (row === undefined) throw new Error('web_server_challenges insert returned no row')

  // Opens the attempt, exactly as `website` does — never throws, never blocks the
  // mint. See `challenge-tasks.ts`.
  await openAttemptForChallenge(db, 'web-server', input.agentId, expiresAt)

  return { outcome: 'minted', row: asRow(row) }
}

function asRow(row: typeof webServerChallenges.$inferSelect): WebServerChallengeRow {
  return {
    id: row.id,
    agentId: row.agentId as AgentId,
    origin: row.origin,
    machineIsSolelyMine: row.machineIsSolelyMine,
    firstPath: row.firstPath,
    firstNonce: row.firstNonce,
    firstServedAt: row.firstServedAt === null ? null : toTimestamp(row.firstServedAt),
    secondPath: row.secondPath,
    secondNonce: row.secondNonce,
    secondServedAt: row.secondServedAt === null ? null : toTimestamp(row.secondServedAt),
    createdAt: toTimestamp(row.createdAt),
    expiresAt: toTimestamp(row.expiresAt),
  }
}

/** This citizen's unexpired challenges, newest first. */
export async function openWebServerChallenges(
  db: Database,
  agentId: AgentId,
): Promise<readonly WebServerChallengeRow[]> {
  const rows = await db
    .select()
    .from(webServerChallenges)
    .where(
      and(eq(webServerChallenges.agentId, agentId), gt(webServerChallenges.expiresAt, sql`now()`)),
    )
    .orderBy(desc(webServerChallenges.createdAt))
    .limit(MAX_OPEN_WEB_SERVER_CHALLENGES)

  return rows.map(asRow)
}

/**
 * Record that a probe was answered.
 *
 * **Called from the verdict's own transaction and from nowhere else** — the
 * verifier reads and does not write (`AGENTS.md` §3), so it states what it found in
 * its metadata and `recordVerification` acts on it, exactly as the account re-check
 * does.
 *
 * Idempotent on each probe: a redelivered verdict finds the column already set and
 * changes nothing, so a replay cannot move `firstServedAt` forward and quietly
 * restart the separation the citizen has already waited out.
 */
export async function recordWebServerProbe(
  db: Database | Transaction,
  input: {
    readonly challengeId: string
    readonly which: WebServerProbe
    readonly at: string
  },
): Promise<boolean> {
  const column =
    input.which === 'first' ? webServerChallenges.firstServedAt : webServerChallenges.secondServedAt

  const rows = await db
    .update(webServerChallenges)
    .set(input.which === 'first' ? { firstServedAt: input.at } : { secondServedAt: input.at })
    .where(and(eq(webServerChallenges.id, input.challengeId), isNull(column)))
    .returning({ id: webServerChallenges.id })

  return rows.length > 0
}
