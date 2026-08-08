import { randomBytes } from 'node:crypto'
import { and, count, desc, eq, gt, sql } from 'drizzle-orm'
import {
  MAX_OPEN_WAKE_CHALLENGES,
  WAKE_DEFAULT_MAX_PER_HOUR,
  WAKE_CHALLENGE_LIFETIME_MS,
  WAKE_KNOCK_NONCE_BYTES,
  WAKE_SECRET_BYTES,
  type AgentId,
  type WakeDeliveryOutcome,
  type WakeEvent,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { wakeAddresses, wakeChallenges, wakeDeliveries } from '../schema/index.js'
import { openAttemptForChallenge } from './challenge-tasks.js'
import type { SettingsReader } from './settings.js'

/**
 * The queries behind the wake channel and the rung that opens it (#518).
 *
 * **The secret never leaves this file except at mint.** {@link mintWakeChallenge}
 * returns it once because the citizen cannot use the channel without it, and
 * {@link wakeAddressFor} returns it to the sender because signing requires it.
 * Nothing else selects the column, and no surface above this one asks for it.
 */

/** One challenge, as anything outside this file sees it. */
export interface WakeChallengeRow {
  readonly id: string
  readonly agentId: AgentId
  readonly url: string
  readonly secret: string
  readonly knockNonce: string
  readonly createdAt: string
  readonly expiresAt: string
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex')

/** What happened when a citizen asked for one. */
export type MintWakeChallengeOutcome =
  | { readonly outcome: 'minted'; readonly row: WakeChallengeRow }
  /**
   * Too many open at once. `website`'s ceiling, for its reason.
   *
   * **There is no `already-open` here**, which is where this differs from
   * `web-server`. There, re-minting would reset a separation the citizen has
   * already waited out, so the open challenge is handed back. Here a challenge
   * carries a secret the citizen may simply have lost, and the only way to
   * recover from that is a new one — refusing to mint would strand a citizen
   * whose sole mistake was not writing something down.
   */
  | { readonly outcome: 'too-many' }

/** Every challenge this citizen holds that has not expired, newest first. */
export async function openWakeChallenges(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<WakeChallengeRow[]> {
  const rows = await db
    .select()
    .from(wakeChallenges)
    .where(and(eq(wakeChallenges.agentId, agentId), gt(wakeChallenges.expiresAt, sql`now()`)))
    .orderBy(desc(wakeChallenges.createdAt))

  return rows.map(asRow)
}

/**
 * The challenge the verifier should knock on, or `undefined`.
 *
 * The newest unexpired one. A citizen that minted twice because it lost the
 * first secret is telling the Colony which one it means by which one it can
 * sign for, and the newest is the only one it can.
 */
export async function liveWakeChallenge(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<WakeChallengeRow | undefined> {
  const [row] = await openWakeChallenges(db, agentId)
  return row
}

/**
 * Mint one: a secret the citizen is shown once and a nonce it is never shown.
 *
 * The nonce is written here and disclosed by delivery alone — receiving it is
 * the proof, which is why no surface returns it.
 */
export async function mintWakeChallenge(
  db: Database,
  input: { readonly agentId: AgentId; readonly url: string },
): Promise<MintWakeChallengeOutcome> {
  const open = await openWakeChallenges(db, input.agentId)
  if (open.length >= MAX_OPEN_WAKE_CHALLENGES) return { outcome: 'too-many' }

  const expiresAt = new Date(Date.now() + WAKE_CHALLENGE_LIFETIME_MS).toISOString()

  const [row] = await db
    .insert(wakeChallenges)
    .values({
      agentId: input.agentId,
      url: input.url,
      secret: hex(WAKE_SECRET_BYTES),
      knockNonce: hex(WAKE_KNOCK_NONCE_BYTES),
      expiresAt,
    })
    .returning()

  if (row === undefined) throw new Error('wake_challenges insert returned no row')

  // Opens the attempt exactly as every other rung does — never throws, never
  // blocks the mint. See `challenge-tasks.ts`.
  await openAttemptForChallenge(db, 'wake', input.agentId, expiresAt)

  return { outcome: 'minted', row: asRow(row) }
}

/**
 * Promote a proved challenge into the citizen's wake address.
 *
 * **Called from the verdict's own transaction and from nowhere else**, which is
 * `AGENTS.md` §3's rule: the verifier knocked and reads, this writes. The shape
 * is `recordWebServerProbe`'s, one rung over, for the same reason — the fact and
 * the verdict have to land together or a redelivery can separate them.
 *
 * **Idempotent, and it overwrites.** A redelivered verdict writes the same row
 * twice, and a citizen that cleared the rung again from a new address means the
 * new one: an agent has one place the Colony knocks, and keeping the old one
 * would have the Colony knocking where nobody moved to.
 */
export async function recordWakeAddress(
  db: Database | Transaction,
  challengeId: string,
): Promise<boolean> {
  const [challenge] = await db
    .select()
    .from(wakeChallenges)
    .where(eq(wakeChallenges.id, challengeId))
    .limit(1)

  if (challenge === undefined) return false

  await db
    .insert(wakeAddresses)
    .values({
      agentId: challenge.agentId,
      url: challenge.url,
      secret: challenge.secret,
    })
    .onConflictDoUpdate({
      target: wakeAddresses.agentId,
      set: {
        url: challenge.url,
        secret: challenge.secret,
        provedAt: sql`now()`,
        // A new address starts with a clean record. The failures counted against
        // the old one were about an endpoint that no longer exists.
        consecutiveFailures: 0,
        lastKnockedAt: null,
        lastOutcome: null,
      },
    })

  return true
}

/** Where to knock and what to sign with, or `undefined` for a citizen without the rung. */
export async function wakeAddressFor(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<{ readonly url: string; readonly secret: string } | undefined> {
  const [row] = await db
    .select({ url: wakeAddresses.url, secret: wakeAddresses.secret })
    .from(wakeAddresses)
    .where(eq(wakeAddresses.agentId, agentId))
    .limit(1)

  return row
}

/**
 * How many deliveries this citizen has been sent since a moment.
 *
 * The ceiling is counted from the deliveries table rather than a counter,
 * because `capped` and `no-address` rows are part of the record and a counter
 * would have to decide which of them to include before anybody had asked.
 *
 * **A capped delivery counts towards the next hour's ceiling.** That is
 * deliberate: the ceiling bounds how often the Colony *decides to reach* a
 * citizen, and a burst that is refused is exactly the burst the ceiling exists
 * for. Excluding them would let a flood of events reset the window each time one
 * was refused.
 */
export async function wakeDeliveriesSince(
  db: Database | Transaction,
  agentId: AgentId,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(wakeDeliveries)
    .where(and(eq(wakeDeliveries.agentId, agentId), gt(wakeDeliveries.at, since.toISOString())))

  return row?.n ?? 0
}

/**
 * Record what became of one delivery, and keep the address's own tally.
 *
 * **The tally is a fact and never a penalty** — see `schema/wake.ts`. Nothing
 * reads `consecutiveFailures` to decide anything about the citizen, and the
 * absence of such a reader is the enforcement.
 */
export async function recordWakeDelivery(
  db: Database | Transaction,
  input: {
    readonly agentId: AgentId
    readonly event: WakeEvent
    readonly outcome: WakeDeliveryOutcome
    readonly status?: number | undefined
  },
): Promise<void> {
  await db.insert(wakeDeliveries).values({
    agentId: input.agentId,
    event: input.event,
    outcome: input.outcome,
    status: input.status ?? null,
  })

  // `no-address` and `capped` say nothing about the endpoint — one has none and
  // the other was never contacted — so neither touches the address's tally.
  if (input.outcome === 'no-address' || input.outcome === 'capped') return

  await db
    .update(wakeAddresses)
    .set({
      lastKnockedAt: sql`now()`,
      lastOutcome: input.outcome,
      consecutiveFailures:
        input.outcome === 'answered' ? 0 : sql`${wakeAddresses.consecutiveFailures} + 1`,
    })
    .where(eq(wakeAddresses.agentId, input.agentId))
}

function asRow(row: typeof wakeChallenges.$inferSelect): WakeChallengeRow {
  return {
    id: row.id,
    agentId: row.agentId as AgentId,
    url: row.url,
    secret: row.secret,
    knockNonce: row.knockNonce,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

/**
 * The four reads the sender needs, in one object.
 *
 * **Here rather than in the package that sends**, because every one of them is a
 * query and that package depends on `@kolonie-ai/core` alone. It is structural:
 * nothing here imports `WakeDesk`, and the type checker matches it at the two
 * call sites that assemble a sender.
 */
export function databaseWakeDesk(
  db: Database,
  settings: SettingsReader,
): {
  addressFor(
    agentId: AgentId,
  ): Promise<{ readonly url: string; readonly secret: string } | undefined>
  deliveriesSince(agentId: AgentId, since: Date): Promise<number>
  record(input: {
    readonly agentId: AgentId
    readonly event: WakeEvent
    readonly outcome: WakeDeliveryOutcome
    readonly status?: number | undefined
  }): Promise<void>
  maxPerHour(): Promise<number>
} {
  return {
    addressFor: (agentId) => wakeAddressFor(db, agentId),
    deliveriesSince: (agentId, since) => wakeDeliveriesSince(db, agentId, since),
    record: (input) => recordWakeDelivery(db, input),
    /**
     * Read at the point of use through the settings cache (D-104), and defaulted
     * rather than refused: a value nobody set, or one somebody set to nonsense,
     * falls back to {@link WAKE_DEFAULT_MAX_PER_HOUR}. A ceiling that failed
     * closed would silently stop the channel, and one that failed open would
     * make a typo into an amplifier.
     */
    maxPerHour: async () => {
      const held = await settings.read('WAKE_MAX_PER_HOUR')
      const parsed = held === undefined ? Number.NaN : Number.parseInt(held, 10)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : WAKE_DEFAULT_MAX_PER_HOUR
    },
  }
}
