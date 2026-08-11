import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import {
  BROWSER_SHARE_LIVE_MINUTES,
  BROWSER_SHARE_OFFER_HOURS,
  BROWSER_SHARE_SKILL,
  now as currentTime,
  type AgentId,
  type HumanId,
  type ShareCloseReason,
  type ShareSummary,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills } from '../schema/agent-skills.js'
import { agents } from '../schema/agents.js'
import { browserShares } from '../schema/browser-shares.js'
import { humanAgents } from '../schema/human-links.js'
import { toTimestamp } from './rows.js'

/**
 * The four acts of a browser share (`#736`): an agent offers one, a person
 * accepts it, either end closes it, and the agent reads back what happened.
 *
 * The reasoning for the channel is in `packages/core/src/browser/share.ts` and
 * what is and is not kept is in `packages/db/src/schema/browser-shares.ts`.
 *
 * **Nothing in this file touches a frame.** There is no argument, no return
 * value and no log line here that could carry one, which is the property the
 * relay depends on and a test asserts by reading what was persisted.
 */

/** Bytes of randomness in a share token. 32 bytes is 256 bits, as a drop's link is. */
const SHARE_TOKEN_BYTES = 32

export interface OfferShareCommand {
  readonly agentId: AgentId
  /** The CDP target the agent is stuck on. One tab, chosen here and never afterwards. */
  readonly targetId: string
  /** The agent's own sentence about what the operator should do on the page (`#737`). */
  readonly purpose: string
  /** Who runs the service, where there is one to name. */
  readonly provider?: string | null | undefined
  /** Which numbered recipe step, where there is a recipe. */
  readonly step?: number | null | undefined
}

export interface OfferedShare {
  readonly id: string
  /**
   * Handed back exactly once, to the agent that asked. The Colony stores only
   * its hash, and the agent passes it to its own sharer.
   */
  readonly token: string
  readonly expiresAt: string
}

/**
 * Why an offer was refused, when it was.
 *
 * `already-open` is the decision's *one open share per agent*, and it is a
 * refusal rather than a queue on purpose: a queued second offer would be an
 * offer against a tab the agent has since moved on from, arriving at an operator
 * who has no way to tell.
 *
 * `no-operator` and `no-skill` are the other two of the three the issue names,
 * and they are decided **here rather than in the caller** (`#737`) because both
 * are one query against state this function is already inside. The caller does
 * the wording: a reason is an enum and a refusal is prose, and the same
 * separation is what {@link AcceptRefusal} already relies on. What must not
 * happen is two layers each holding half the rule, which is how they come to
 * disagree about which half ran.
 */
export type OfferRefusal = 'already-open' | 'no-operator' | 'no-skill'

export type OfferShareOutcome =
  | { readonly outcome: 'offered'; readonly share: OfferedShare }
  | { readonly outcome: 'refused'; readonly reason: OfferRefusal }

/**
 * Mint one share. Only ever called on an agent's own authenticated request —
 * *the agent initiates, always* is the first of the decision's five limits, and
 * there is no path in this file that creates a row for anybody else.
 *
 * **All three refusals are decided before the insert and in this order**:
 * already-open, then no operator, then no skill. The order is what a citizen
 * reads, so it runs cheapest-to-fix first — an agent with a share already open
 * should be told that, not sent off to earn a rung it may already hold.
 */
export async function offerShare(
  db: Database,
  command: OfferShareCommand,
): Promise<OfferShareOutcome> {
  const at = currentTime()
  await expireStaleShares(db, at)

  const open = await liveShare(db, command.agentId)
  if (open !== null) return { outcome: 'refused', reason: 'already-open' }

  /**
   * *Only the linked operator may accept* is checked again at acceptance, and
   * checking it here as well is not redundancy: a share nobody could ever accept
   * is a share that will sit for six hours and close `expired`, and the agent
   * would learn on its next waking that it had been waiting on nobody. Refusing
   * at the offer is the difference between a wasted six hours and a sentence.
   */
  const [operator] = await db
    .select({ humanId: humanAgents.humanId })
    .from(humanAgents)
    .where(eq(humanAgents.agentId, command.agentId))
    .limit(1)

  if (operator === undefined) return { outcome: 'refused', reason: 'no-operator' }

  const [held] = await db
    .select({ skill: agentSkills.skill })
    .from(agentSkills)
    .where(
      and(eq(agentSkills.agentId, command.agentId), eq(agentSkills.skill, BROWSER_SHARE_SKILL)),
    )
    .limit(1)

  if (held === undefined) return { outcome: 'refused', reason: 'no-skill' }

  const token = randomBytes(SHARE_TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.parse(at) + BROWSER_SHARE_OFFER_HOURS * 3_600_000)

  const [row] = await db
    .insert(browserShares)
    .values({
      agentId: command.agentId,
      tokenHash: hashToken(token),
      targetId: command.targetId,
      purpose: command.purpose,
      provider: command.provider ?? null,
      step: command.step ?? null,
      expiresAt: expiresAt.toISOString(),
    })
    .returning({ id: browserShares.id, expiresAt: browserShares.expiresAt })

  if (row === undefined) throw new Error('browser_shares insert returned no row')

  return { outcome: 'offered', share: { id: row.id, token, expiresAt: row.expiresAt } }
}

/**
 * The one share this agent has going, if it has one. `offered` or `live`, never
 * closed and never expired.
 *
 * This is both what `kolonie.browser.share.status` answers and what
 * {@link offerShare} refuses a second offer against, and those being the same
 * query is the point: an agent cannot be told *nothing is open* and then refused
 * for having something open.
 */
export async function liveShare(db: Database, agentId: AgentId): Promise<ShareSummary | null> {
  const at = currentTime()
  const [row] = await db
    .select({
      id: browserShares.id,
      targetId: browserShares.targetId,
      purpose: browserShares.purpose,
      provider: browserShares.provider,
      step: browserShares.step,
      offeredAt: browserShares.offeredAt,
      expiresAt: browserShares.expiresAt,
      acceptedAt: browserShares.acceptedAt,
      closedAt: browserShares.closedAt,
      closedFor: browserShares.closedFor,
    })
    .from(browserShares)
    .where(
      and(
        eq(browserShares.agentId, agentId),
        isNull(browserShares.closedAt),
        sql`${browserShares.expiresAt} > ${at}`,
      ),
    )
    .limit(1)

  return row === undefined ? null : toSummary(row)
}

/** The last share this agent had, open or closed, for reading back after the fact. */
export async function latestShare(db: Database, agentId: AgentId): Promise<ShareSummary | null> {
  const [row] = await db
    .select({
      id: browserShares.id,
      targetId: browserShares.targetId,
      purpose: browserShares.purpose,
      provider: browserShares.provider,
      step: browserShares.step,
      offeredAt: browserShares.offeredAt,
      expiresAt: browserShares.expiresAt,
      acceptedAt: browserShares.acceptedAt,
      closedAt: browserShares.closedAt,
      closedFor: browserShares.closedFor,
    })
    .from(browserShares)
    .where(eq(browserShares.agentId, agentId))
    .orderBy(sql`${browserShares.offeredAt} desc`)
    .limit(1)

  return row === undefined ? null : toSummary(row)
}

/**
 * The share a waking citizen needs to be told about, or null (`#737`).
 *
 * **This is the call that makes *offer, end the turn, sleep* a real sequence
 * rather than a slogan.** An agent that offered a share and slept has no memory
 * of having done it; if nothing greeted it on waking, the only way back to the
 * answer would be to remember to ask, which is precisely the thing a stateless
 * citizen cannot be relied on to do.
 *
 * Two kinds of share qualify, and between them they cover every outcome the
 * agent could act on:
 *
 * - **Still open** — offered and waiting, or live with somebody on it. Reported
 *   regardless of when it was offered, because an obligation does not stop being
 *   one for being older than the window. This follows the same *standing rather
 *   than news* rule that unread operator notes and the wake channel already
 *   follow.
 * - **Closed inside the window** — completed, expired, lost or cancelled since
 *   the citizen was last here. This is the answer arriving, and it is the only
 *   half that is bounded by `since`: a share that closed three sessions ago has
 *   been read and does not deserve to be re-announced forever.
 *
 * The sweep runs first, so an offer that lapsed while the citizen was away is
 * reported as `expired` rather than as still waiting. Nobody wakes to a promise
 * that a tab is being watched when the six hours ran out at three in the
 * morning.
 */
export async function shareForWakeup(
  db: Database,
  agentId: AgentId,
  since: string,
): Promise<ShareSummary | null> {
  await expireStaleShares(db, currentTime())

  const [row] = await db
    .select({
      id: browserShares.id,
      targetId: browserShares.targetId,
      purpose: browserShares.purpose,
      provider: browserShares.provider,
      step: browserShares.step,
      offeredAt: browserShares.offeredAt,
      expiresAt: browserShares.expiresAt,
      acceptedAt: browserShares.acceptedAt,
      closedAt: browserShares.closedAt,
      closedFor: browserShares.closedFor,
    })
    .from(browserShares)
    .where(
      and(
        eq(browserShares.agentId, agentId),
        or(isNull(browserShares.closedAt), sql`${browserShares.closedAt} >= ${since}`),
      ),
    )
    .orderBy(sql`${browserShares.offeredAt} desc`)
    .limit(1)

  return row === undefined ? null : toSummary(row)
}

/**
 * What the relay resolves a presented token to, and the whole of what it is
 * allowed to know.
 *
 * No agent name, no operator name, no page, no target beyond the one the sharer
 * is expected to already be attached to. The relay is a socket pump with a token
 * check and this is the token check's entire vocabulary.
 */
export interface ShareForRelay {
  readonly id: string
  readonly agentId: string
  readonly targetId: string
  readonly acceptedAt: string | null
  readonly expiresAt: string
}

/**
 * Resolve a token to the share it opens, or null.
 *
 * **Null for every closed state**, and that is the contract rather than an
 * omission: expired, completed, lost, cancelled, erased with its citizen, never
 * existed. A socket presenting a guessed token learns nothing about whether it
 * ever named anything, which is the property the durable operator page and the
 * drop link already hold.
 */
export async function shareForToken(db: Database, token: string): Promise<ShareForRelay | null> {
  return openShare(db, eq(browserShares.tokenHash, hashToken(token)))
}

/**
 * The same share, named the way the operator's side knows it.
 *
 * **The operator is never handed the token**, and could not be: the Colony keeps
 * only its hash. So the two ends of one share arrive by different names — the
 * sharer presents the secret it was given, and the person presents an id it read
 * off its own queue and a session cookie that says who it is. Which of those
 * proves what is the whole difference between the two doors.
 */
async function shareById(db: Database, shareId: string): Promise<ShareForRelay | null> {
  return openShare(db, eq(browserShares.id, shareId))
}

async function openShare(db: Database, matches: SQL): Promise<ShareForRelay | null> {
  const at = currentTime()
  const [row] = await db
    .select({
      id: browserShares.id,
      agentId: browserShares.agentId,
      targetId: browserShares.targetId,
      acceptedAt: browserShares.acceptedAt,
      expiresAt: browserShares.expiresAt,
    })
    .from(browserShares)
    .where(and(matches, isNull(browserShares.closedAt), sql`${browserShares.expiresAt} > ${at}`))
    .limit(1)

  return row ?? null
}

/**
 * Why a person was not let onto a share.
 *
 * Three reasons and no fourth. `unknown` covers never-existed, closed, expired
 * and belonging-to-somebody-else's-agent — the same silence
 * {@link shareForToken} keeps, and for the same reason: a guessed id must not
 * answer differently from an invented one. `not-yours` is the case where the id
 * *was* real and the person is not the agent's operator, which cannot be reached
 * by guessing and so may be said out loud.
 */
export type AcceptRefusal = 'unknown' | 'not-yours' | 'taken'

export type AcceptShareOutcome =
  | { readonly outcome: 'accepted'; readonly share: ShareForRelay }
  | { readonly outcome: 'refused'; readonly reason: AcceptRefusal }

/**
 * A person takes up an offer, naming it by the id their own queue showed them.
 *
 * Three things happen at once and they are one statement rather than three, so
 * that two windows opened on the same offer cannot both believe they are the
 * one: the row is stamped with who and when, and `expires_at` is **rewritten**
 * from the end of the patient offer window to the end of the short live one.
 *
 * `not-yours` is *only the linked operator* — the third of the decision's four
 * questions — and it is checked here, against `human_agents`, rather than
 * anywhere a page could be reached without it.
 *
 * **The person who already accepted may accept again, and is not refused.** A
 * reloaded window, a laptop that slept, a second tab: all of them arrive here
 * with a share this person is already on, and refusing would end a live session
 * over a browser event nobody chose. It does not extend the live window — the
 * clock keeps running from the first acceptance, which is what stops a reload
 * being a way to hold a tab open indefinitely. `taken` is left for the case it
 * actually names: somebody else's window is on it.
 */
export async function acceptShare(
  db: Database,
  shareId: string,
  humanId: HumanId,
): Promise<AcceptShareOutcome> {
  const at = currentTime()
  const share = await shareById(db, shareId)
  if (share === null) return { outcome: 'refused', reason: 'unknown' }

  const [link] = await db
    .select({ agentId: humanAgents.agentId })
    .from(humanAgents)
    .where(and(eq(humanAgents.humanId, humanId), eq(humanAgents.agentId, share.agentId)))
    .limit(1)

  if (link === undefined) return { outcome: 'refused', reason: 'not-yours' }

  const liveUntil = new Date(Date.parse(at) + BROWSER_SHARE_LIVE_MINUTES * 60_000).toISOString()

  const [row] = await db
    .update(browserShares)
    .set({ acceptedBy: humanId, acceptedAt: at, expiresAt: liveUntil })
    .where(and(eq(browserShares.id, share.id), isNull(browserShares.acceptedAt)))
    .returning({
      id: browserShares.id,
      agentId: browserShares.agentId,
      targetId: browserShares.targetId,
      acceptedAt: browserShares.acceptedAt,
      expiresAt: browserShares.expiresAt,
    })

  if (row !== undefined) return { outcome: 'accepted', share: row }

  /**
   * The update matched nothing, which means somebody accepted between the read
   * and the write. Whether that somebody was this person deciding to reload is
   * read back rather than assumed.
   */
  const taken = await shareById(db, shareId)
  if (taken === null) return { outcome: 'refused', reason: 'unknown' }

  const [holder] = await db
    .select({ acceptedBy: browserShares.acceptedBy })
    .from(browserShares)
    .where(eq(browserShares.id, shareId))
    .limit(1)

  return holder?.acceptedBy === humanId
    ? { outcome: 'accepted', share: taken }
    : { outcome: 'refused', reason: 'taken' }
}

/**
 * End a share, and say why.
 *
 * Idempotent by the `closed_at is null` guard, because the ways a share ends
 * race by construction: the operator closes the window at the moment the
 * sharer's socket drops, and both paths arrive here. The first reason wins, and
 * neither caller has to hold a lock to find out that it lost.
 */
export async function closeShare(
  db: Database,
  shareId: string,
  reason: ShareCloseReason,
): Promise<boolean> {
  const rows = await db
    .update(browserShares)
    .set({ closedAt: currentTime(), closedFor: reason })
    .where(and(eq(browserShares.id, shareId), isNull(browserShares.closedAt)))
    .returning({ id: browserShares.id })

  return rows.length > 0
}

/**
 * Close everything whose window has run out, whichever of the two windows it
 * was in.
 *
 * Called before an offer is minted and before the queue is read, rather than
 * from a timer: a lapsed share has to *become* closed for the agent to read the
 * reason back, and doing it on the paths that already ask the question means
 * there is no sweep to forget to deploy. A share nobody ever asks about again
 * costs one row.
 */
export async function expireStaleShares(db: Database, at: string = currentTime()): Promise<number> {
  const rows = await db
    .update(browserShares)
    .set({ closedAt: at, closedFor: 'expired' })
    .where(and(isNull(browserShares.closedAt), lte(browserShares.expiresAt, at)))
    .returning({ id: browserShares.id })

  return rows.length
}

/**
 * One share, named for the person who is about to look at it (`#738`).
 *
 * The agent's sentence travels with it (`#737`), because it is the only thing
 * the person will read before deciding: *colette is stuck* asks them to open a
 * live session to find out what for, and *solve the image challenge and press
 * Continue* is a two-minute job they can accept or leave.
 *
 * **Still no frame, no page title and no URL.** What the window renders arrives
 * over the socket and is never written down, so there is nothing here that could
 * describe the tab — only what the agent said about it.
 */
export interface WaitingShare {
  readonly shareId: string
  readonly agentName: string
  readonly purpose: string
  readonly provider: string | null
  readonly step: number | null
  readonly offeredAt: string
  readonly expiresAt: string
}

/**
 * The share behind an id, if this person may open its window.
 *
 * **Null and never a refusal**, the same silence {@link shareForToken} keeps: a
 * guessed id, somebody else's agent, a share that closed an hour ago and one
 * that never existed all answer identically, so the console can hand every one
 * of them what a non-existent page gets. `#738` asks for exactly that.
 *
 * **Accepted shares are included**, unlike the queue that led here. A window is
 * reloaded, a laptop sleeps, a tab is duplicated — all of those come back to
 * this read with a share the person is already on, and refusing would end a live
 * session over a browser event nobody chose. Whether *this* person may resume it
 * is {@link acceptShare}'s question, asked again at the socket where it can be
 * answered against `accepted_by`.
 */
export async function shareOfferedTo(
  db: Database,
  shareId: string,
  humanId: HumanId,
): Promise<WaitingShare | null> {
  const at = currentTime()

  const [row] = await db
    .select({
      shareId: browserShares.id,
      agentName: agents.name,
      purpose: browserShares.purpose,
      provider: browserShares.provider,
      step: browserShares.step,
      offeredAt: browserShares.offeredAt,
      expiresAt: browserShares.expiresAt,
    })
    .from(browserShares)
    .innerJoin(humanAgents, eq(humanAgents.agentId, browserShares.agentId))
    .innerJoin(agents, eq(agents.id, browserShares.agentId))
    .where(
      and(
        eq(browserShares.id, shareId),
        eq(humanAgents.humanId, humanId),
        isNull(browserShares.closedAt),
        sql`${browserShares.expiresAt} > ${at}`,
      ),
    )
    .limit(1)

  return row ?? null
}

/**
 * A finished handover: an agent's own shared tab that its operator was on, and
 * that has since ended (`#739`).
 *
 * Only the four facts a verdict is allowed to rest on. No purpose, no provider,
 * no target and no operator — what the person did on the tab is not written down
 * anywhere, and the badge is not a judgement about it.
 */
export interface FinishedHandover {
  readonly shareId: string
  readonly acceptedAt: string
  readonly closedAt: string
  readonly closedFor: ShareCloseReason
}

/**
 * The handover this agent was inside at a given moment, if it was inside one
 * (`#739`).
 *
 * **The interval is the whole question.** A challenge cleared at `at` counts for
 * the badge when `accepted_at <= at <= closed_at` on a share of this agent's own
 * — the operator had joined, and had not yet left. Read the other way round: the
 * page the person was looking at when they solved it was this agent's page, in
 * this agent's session, on a tab this agent chose.
 *
 * **`closed_at is not null` is a condition and not an accident.** The rung is
 * earned on the completion rather than on the offer, so a share still running is
 * not yet an answer: the agent carries on in the same session and hands in
 * afterwards, and by then the session it is reporting on has ended. A share that
 * is still open at submission time means the agent submitted mid-handover, which
 * is the one shape this must not pass.
 *
 * Every close reason is accepted, `expired` and `lost` included. What matters is
 * that the person was on the tab at the moment the challenge went through; a
 * socket that dropped a minute later says something about a network and nothing
 * about the handover. The reason travels back so the verdict can quote it.
 *
 * Null when there is no such share — which is the ordinary answer for an agent
 * that cleared the challenge by itself, and is the answer the rung now turns on.
 */
export async function handoverAround(
  db: Database,
  agentId: AgentId,
  at: string,
): Promise<FinishedHandover | null> {
  const [row] = await db
    .select({
      shareId: browserShares.id,
      acceptedAt: browserShares.acceptedAt,
      closedAt: browserShares.closedAt,
      closedFor: browserShares.closedFor,
    })
    .from(browserShares)
    .where(
      and(
        eq(browserShares.agentId, agentId),
        sql`${browserShares.acceptedAt} is not null`,
        sql`${browserShares.closedAt} is not null`,
        sql`${browserShares.acceptedAt} <= ${at}`,
        sql`${browserShares.closedAt} >= ${at}`,
      ),
    )
    // Newest first, so an agent that has handed over several times is answered
    // with the session the clear actually fell in rather than with whichever row
    // the planner reached first. The interval makes at most one of them right;
    // the ordering makes the query say so.
    .orderBy(sql`${browserShares.acceptedAt} desc`)
    .limit(1)

  if (row === undefined) return null
  if (row.acceptedAt === null || row.closedAt === null || row.closedFor === null) return null

  return {
    shareId: row.shareId,
    acceptedAt: toTimestamp(row.acceptedAt),
    closedAt: toTimestamp(row.closedAt),
    closedFor: row.closedFor as ShareCloseReason,
  }
}

interface SummaryRow {
  readonly id: string
  readonly targetId: string
  readonly purpose: string
  readonly provider: string | null
  readonly step: number | null
  readonly offeredAt: string
  readonly expiresAt: string
  readonly acceptedAt: string | null
  readonly closedAt: string | null
  readonly closedFor: string | null
}

function toSummary(row: SummaryRow): ShareSummary {
  return {
    id: row.id,
    state: row.closedAt !== null ? 'closed' : row.acceptedAt !== null ? 'live' : 'offered',
    targetId: row.targetId,
    purpose: row.purpose,
    provider: row.provider,
    step: row.step,
    offeredAt: toTimestamp(row.offeredAt),
    expiresAt: toTimestamp(row.expiresAt),
    acceptedAt: row.acceptedAt === null ? null : toTimestamp(row.acceptedAt),
    closedAt: row.closedAt === null ? null : toTimestamp(row.closedAt),
    closedFor: row.closedFor === null ? null : (row.closedFor as ShareCloseReason),
  }
}

/** SHA-256, hex. The same shape `credentials` and `operator_drops` use. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
