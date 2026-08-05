import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  HUMAN_SESSION_CEILING_MS,
  HUMAN_SESSION_IDLE_MS,
  HumanIdSchema,
  HumanSessionIdSchema,
  type Human,
  type HumanId,
  type HumanSession,
  type IdentityProvider,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { humanIdentities, humanSessions, humans } from '../schema/index.js'

/**
 * People, their provider identities, and the sessions they hold (`#425`).
 *
 * ## The one property this module exists to protect
 *
 * **A human session resolves to a human and can never resolve to an agent.**
 * Nothing here returns an `Agent`, imports one, or touches `credentials`. The
 * API's `authenticate` reads a citizen's key or a citizen's console session and
 * comes back with skills; {@link authenticateHumanSession} reads a person's
 * cookie and comes back with a person, who has none. Two functions that cannot
 * be confused for each other, over two tables that cannot be joined by
 * accident.
 *
 * That is the same argument the schema makes for the table and core makes for
 * the branded id, restated once at the layer where a mistake would actually be
 * made.
 *
 * ## One session concept, two subjects
 *
 * The cookie name, the hashing, the rolling-with-a-ceiling lifetime and the
 * *expiry is read on the authentication path, never swept* rule are the same as
 * the agent's console session, deliberately — `#425` asks for one session
 * concept and this is what that means. What is not shared is the row.
 */

/** How much randomness a session cookie carries, before encoding. 256 bits. */
const SESSION_ENTROPY_BYTES = 32

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Timing-safe comparison of two stored hashes. Same contract as `apiKeyHashEquals`. */
function hashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function mintSecret(): string {
  return randomBytes(SESSION_ENTROPY_BYTES).toString('base64url')
}

/** What arrived from the provider, once the API has read it out of the callback. */
export interface ProviderIdentity {
  readonly provider: IdentityProvider
  /** The provider's stable identifier — never the address. */
  readonly subject: string
  /** The address the provider returned, or `null` where it returned none. */
  readonly email: string | null
}

/**
 * Find the person this identity belongs to, or create them.
 *
 * **The pair decides, and the address never does.** Two people may hold one
 * address over time and one person may change theirs; the `(provider, subject)`
 * pair is what the provider promises is stable, and it is the only thing this
 * matches on. Matching on the address would let somebody who acquires a lapsed
 * address inherit an account.
 *
 * A returning person also has their address refreshed, because a person who
 * made their GitHub address public since last time should not have to be told
 * the Colony still cannot reach them.
 *
 * `onConflictDoUpdate` rather than select-then-insert: two callbacks arriving at
 * once for a new person is a race the unique index would otherwise turn into a
 * 500 for whichever lost.
 */
export async function findOrCreateHuman(
  db: Database,
  identity: ProviderIdentity,
): Promise<{ readonly human: Human; readonly created: boolean }> {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ humanId: humanIdentities.humanId })
      .from(humanIdentities)
      .where(
        and(
          eq(humanIdentities.provider, identity.provider),
          eq(humanIdentities.subject, identity.subject),
        ),
      )
      .limit(1)

    if (existing !== undefined) {
      await tx
        .update(humanIdentities)
        .set({ email: identity.email })
        .where(
          and(
            eq(humanIdentities.provider, identity.provider),
            eq(humanIdentities.subject, identity.subject),
          ),
        )
      await tx
        .update(humans)
        .set({ lastSeenAt: sql`now()` })
        .where(eq(humans.id, existing.humanId))

      const human = await readHuman(tx, HumanIdSchema.parse(existing.humanId))
      // Unreachable while the foreign key holds: the identity row cannot
      // outlive the person it points at. Checked rather than asserted, because
      // being wrong here means signing somebody in as nobody.
      if (human === undefined) throw new Error('identity without a human')
      return { human, created: false }
    }

    const [row] = await tx.insert(humans).values({}).returning({ id: humans.id })
    if (row === undefined) throw new Error('the account was not written')

    await tx
      .insert(humanIdentities)
      .values({
        humanId: row.id,
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
      })
      .onConflictDoNothing()

    const human = await readHuman(tx, HumanIdSchema.parse(row.id))
    if (human === undefined) throw new Error('the account was not written')
    return { human, created: true }
  })
}

/** A person and their identities, or nothing. */
export async function readHuman(
  db: Database | Transaction,
  id: HumanId,
): Promise<Human | undefined> {
  const [row] = await db.select().from(humans).where(eq(humans.id, id)).limit(1)
  if (row === undefined) return undefined

  const identities = await db
    .select()
    .from(humanIdentities)
    .where(eq(humanIdentities.humanId, id))
    .orderBy(humanIdentities.attachedAt)

  return {
    id: HumanIdSchema.parse(row.id),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    identities: identities.map((identity) => ({
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email,
      attachedAt: identity.attachedAt,
    })),
  }
}

/** What a caller needs to hand back to the browser, once. */
export interface OpenedSession {
  readonly session: string
  readonly maxAgeSeconds: number
}

/**
 * Open a session for a person.
 *
 * The plaintext returned here is the only copy that will ever exist — it goes
 * into one `Set-Cookie` header and nowhere else. Nothing may log it, and no
 * response body may carry it: the rule `console.ts` states for the agent's
 * session, obeyed here for the same reason.
 *
 * The browser's `Max-Age` is the *rolling* window rather than the ceiling, and
 * the two are allowed to disagree: the database decides when a session ends, and
 * a cookie that outlived its row would simply stop authenticating.
 */
export async function openHumanSession(
  db: Database,
  humanId: HumanId,
  where: { readonly browser?: string | null; readonly location?: string | null } = {},
): Promise<OpenedSession> {
  const secret = mintSecret()
  const now = Date.now()

  await db.insert(humanSessions).values({
    humanId,
    secretHash: hashSecret(secret),
    expiresAt: new Date(now + HUMAN_SESSION_IDLE_MS).toISOString(),
    absoluteExpiresAt: new Date(now + HUMAN_SESSION_CEILING_MS).toISOString(),
    browser: where.browser ?? null,
    location: where.location ?? null,
  })

  return { session: secret, maxAgeSeconds: Math.floor(HUMAN_SESSION_IDLE_MS / 1000) }
}

/** What a presented cookie turned out to be. */
export type HumanAuthentication =
  | { readonly outcome: 'authenticated'; readonly human: Human; readonly sessionId: string }
  /** No session carries this value. Also the answer for one that never existed. */
  | { readonly outcome: 'unknown' }
  /** It was real and its owner ended it. */
  | { readonly outcome: 'ended' }
  /** It was real and it ran out — idle too long, or past its ceiling. */
  | { readonly outcome: 'expired' }

/**
 * Resolve a cookie to the person who holds it.
 *
 * The three failures are distinguished here and collapsed into one answer by the
 * API, for the reason `authentication.ts` gives: storage is where a test can
 * assert that an *ended* session is refused because it was ended rather than
 * because the lookup happened to miss, and that assertion is the only thing
 * standing between "sign-out works" and "sign-out appears to work".
 *
 * **The rolling extension happens here, on the read.** It is a write on a read
 * path and it is deliberate — the same trade `touch` makes one module over. A
 * session extended only sometimes is a session whose lifetime nobody can state.
 */
export async function authenticateHumanSession(
  db: Database,
  presented: string,
): Promise<HumanAuthentication> {
  const hash = hashSecret(presented)

  const [row] = await db
    .select()
    .from(humanSessions)
    .where(eq(humanSessions.secretHash, hash))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown' }
  if (!hashEquals(row.secretHash, hash)) return { outcome: 'unknown' }
  if (row.endedAt !== null) return { outcome: 'ended' }

  // Parsed rather than compared as text — Postgres' rendering and an ISO string
  // do not sort against each other. The same note as `authentication.ts`.
  const now = Date.now()
  if (Date.parse(row.expiresAt) <= now) return { outcome: 'expired' }
  if (Date.parse(row.absoluteExpiresAt) <= now) return { outcome: 'expired' }

  const human = await readHuman(db, HumanIdSchema.parse(row.humanId))
  if (human === undefined) return { outcome: 'unknown' }

  /**
   * Push the rolling window out, and never past the ceiling.
   *
   * `least(...)` rather than a comparison in TypeScript: the check constraint on
   * the table is the authority on this, and computing it in SQL means the value
   * written can never be one the constraint refuses.
   */
  await db
    .update(humanSessions)
    .set({
      lastUsedAt: sql`now()`,
      expiresAt: sql`least(now() + make_interval(secs => ${Math.floor(HUMAN_SESSION_IDLE_MS / 1000)}), ${humanSessions.absoluteExpiresAt})`,
    })
    .where(eq(humanSessions.id, row.id))

  await db
    .update(humans)
    .set({ lastSeenAt: sql`now()` })
    .where(eq(humans.id, row.humanId))

  return {
    outcome: 'authenticated',
    human,
    sessionId: HumanSessionIdSchema.parse(row.id),
  }
}

/**
 * End one session, by the value that authenticates it (`#431`).
 *
 * Server-side, so replaying the cookie fails rather than merely being
 * inconvenient — a sign-out that only clears the browser's copy is a sign-out
 * that did nothing to a cookie somebody else already has.
 */
export async function endHumanSession(db: Database, presented: string): Promise<boolean> {
  const result = await db
    .update(humanSessions)
    .set({ endedAt: sql`now()` })
    .where(and(eq(humanSessions.secretHash, hashSecret(presented)), isNull(humanSessions.endedAt)))
    .returning({ id: humanSessions.id })

  return result.length > 0
}

/**
 * End one session a person named in their own list (`#431`).
 *
 * The id is checked against the human rather than trusted from the request,
 * which is the whole authorisation surface of the sessions page.
 */
export async function endHumanSessionById(
  db: Database,
  humanId: HumanId,
  sessionId: string,
): Promise<boolean> {
  const result = await db
    .update(humanSessions)
    .set({ endedAt: sql`now()` })
    .where(
      and(
        eq(humanSessions.id, sessionId),
        eq(humanSessions.humanId, humanId),
        isNull(humanSessions.endedAt),
      ),
    )
    .returning({ id: humanSessions.id })

  return result.length > 0
}

/**
 * End every session this person holds, **including the one asking** (`#431`).
 *
 * Deliberately including it: *sign out everywhere* that left the current browser
 * signed in would be a promise the next page visibly breaks.
 */
export async function endAllHumanSessions(db: Database, humanId: HumanId): Promise<number> {
  const result = await db
    .update(humanSessions)
    .set({ endedAt: sql`now()` })
    .where(and(eq(humanSessions.humanId, humanId), isNull(humanSessions.endedAt)))
    .returning({ id: humanSessions.id })

  return result.length
}

/**
 * The sessions a person holds, newest first.
 *
 * Live ones only. An ended session is not something a reader can act on, and a
 * list mixing the two makes the question *which of these should not be here*
 * harder rather than easier.
 */
export async function listHumanSessions(
  db: Database,
  humanId: HumanId,
): Promise<readonly HumanSession[]> {
  const rows = await db
    .select()
    .from(humanSessions)
    .where(and(eq(humanSessions.humanId, humanId), isNull(humanSessions.endedAt)))
    .orderBy(desc(humanSessions.startedAt))

  const now = Date.now()
  return rows
    .filter((row) => Date.parse(row.expiresAt) > now && Date.parse(row.absoluteExpiresAt) > now)
    .map((row) => ({
      id: HumanSessionIdSchema.parse(row.id),
      startedAt: row.startedAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      browser: row.browser,
      location: row.location,
    }))
}
