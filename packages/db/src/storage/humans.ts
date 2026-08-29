import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  HUMAN_SESSION_CEILING_MS,
  HUMAN_SESSION_IDLE_MS,
  HumanIdSchema,
  HumanRoleSchema,
  HumanSessionIdSchema,
  type Human,
  type HumanId,
  type HumanRole,
  type HumanSession,
  type IdentityProvider,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { authorityEvents, humanIdentities, humanSessions, humans } from '../schema/index.js'

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
 * What happened when an identity arrived.
 *
 * **Four outcomes and not a boolean** (`#574`). It was
 * `{ human, created }`, which could say *this person is new* and *this person
 * was already here* — and once an identity can attach to an account that
 * already exists, those two no longer cover the answers. `ambiguous` in
 * particular has **no person in it at all**, which a boolean cannot express and
 * a caller must not be able to ignore.
 */
export type IdentityArrival =
  /** The `(provider, subject)` pair was already here. The ordinary sign-in. */
  | { readonly outcome: 'returning'; readonly human: Human }
  /** Nothing matched, so a person was written. */
  | { readonly outcome: 'created'; readonly human: Human }
  /** Unknown pair, one verified address, one match: attached to that person. */
  | { readonly outcome: 'attached'; readonly human: Human }
  /**
   * Unknown pair whose address matches **more than one** person.
   *
   * Nothing was written and nobody is signed in. See the refusal in
   * {@link findOrCreateHuman}.
   */
  | { readonly outcome: 'ambiguous'; readonly human?: undefined }

/**
 * Find the person this identity belongs to, attach it to them, or create them.
 *
 * **The pair decides who this *is*, and the address never does.** Two people
 * may hold one address over time and one person may change theirs; the
 * `(provider, subject)` pair is what the provider promises is stable, and it is
 * the only thing an *existing* identity is matched on. Matching an existing
 * identity by address would let somebody who acquires a lapsed address inherit
 * an account.
 *
 * A returning person also has their address refreshed, because a person who
 * made their GitHub address public since last time should not have to be told
 * the Colony still cannot reach them.
 *
 * ## The address decides what an unknown identity *joins* (`#574`)
 *
 * `packages/db/src/schema/humans.ts` states the intent this function never
 * carried out: *"a person who signs in with GitHub today and Google tomorrow is
 * one person"*. Nothing ever wrote the second identity, so they were two.
 *
 * An unknown pair carrying a verified address now attaches to the one person
 * who already holds that address. **The objection to this did not survive**, and
 * it is recorded because it is the obvious one: that control of a mailbox
 * becomes sufficient to reach an account holding `maintainer`. It is already
 * sufficient — whoever controls the mailbox can reset the provider account
 * itself and arrive through the front door. The address is the root of trust for
 * every provider offered here, so attaching on the strength of it grants no
 * authority that was not already reachable.
 *
 * Three conditions, and every one is load-bearing:
 *
 * - **Both addresses are provider-verified**, guaranteed by construction rather
 *   than checked here: `readProfile` writes `human_identities.email` only when
 *   the provider said `email_verified`, and never for a GitHub noreply address.
 *   So a non-null value in that column is already verified.
 * - **Exactly one person matches.** Two or more is refused and creates nothing,
 *   for the same reason `bootstrapMaintainer` refuses an ambiguous subject:
 *   granting to whichever row the planner returned first is the one outcome
 *   that could hand somebody authority over another person's Colony.
 * - **`null` is not a match.** The private-GitHub-address case `#426` decided
 *   lands here as a new account, exactly as before. Two people who both hold no
 *   address are not each other, and SQL agrees — but the query says so out loud
 *   rather than relying on it.
 *
 * **Merging two accounts that already exist is deliberately not here.** A merge
 * has to decide what happens to two sponsor identities, two sets of operated
 * agents and two role arrays, and every answer is a guess. This attaches to a
 * person who already exists, so the question is never asked.
 *
 * `onConflictDoNothing` rather than select-then-insert on the write: two
 * callbacks arriving at once for a new person is a race the unique index would
 * otherwise turn into a 500 for whichever lost.
 */
/**
 * The person this pair already belongs to, or nobody (`#1764`).
 *
 * **Lookup only.** The workplace SPA must not mint a Colony human on first
 * visit — unknown `(provider, subject)` is the same answer as a bad token, so
 * this function writes nothing, attaches nothing by address, and does not
 * refresh `lastSeenAt`. The console's {@link findOrCreateHuman} remains the
 * path that creates.
 */
export async function findHumanByIdentity(
  db: Database,
  identity: Pick<ProviderIdentity, 'provider' | 'subject'>,
): Promise<Human | undefined> {
  const [existing] = await db
    .select({ humanId: humanIdentities.humanId })
    .from(humanIdentities)
    .where(
      and(
        eq(humanIdentities.provider, identity.provider),
        eq(humanIdentities.subject, identity.subject),
      ),
    )
    .limit(1)

  if (existing === undefined) return undefined
  return await readHuman(db, HumanIdSchema.parse(existing.humanId))
}

export async function findOrCreateHuman(
  db: Database,
  identity: ProviderIdentity,
): Promise<IdentityArrival> {
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
      return { outcome: 'returning', human }
    }

    /**
     * An unknown pair. Before writing a person, ask whether one already holds
     * this address (`#574`).
     *
     * `distinct` on `human_id` and not on the row: one person may hold two
     * identities carrying the same address — GitHub and Google under one
     * mailbox is the ordinary case this feature exists for — and two rows
     * pointing at one person is one match, not an ambiguity.
     *
     * Limited to two, because the only question is *one, or more than one*.
     */
    if (identity.email !== null) {
      const matches = await tx
        .selectDistinct({ humanId: humanIdentities.humanId })
        .from(humanIdentities)
        .where(eq(humanIdentities.email, identity.email))
        .limit(2)

      if (matches.length > 1) {
        // Nothing written, nobody signed in, and deliberately no hint about how
        // many: the caller renders one sentence and the reader learns nothing
        // about other people's accounts from it.
        return { outcome: 'ambiguous' }
      }

      const [only] = matches
      if (only !== undefined) {
        await tx
          .insert(humanIdentities)
          .values({
            humanId: only.humanId,
            provider: identity.provider,
            subject: identity.subject,
            email: identity.email,
          })
          .onConflictDoNothing()

        await tx
          .update(humans)
          .set({ lastSeenAt: sql`now()` })
          .where(eq(humans.id, only.humanId))

        const human = await readHuman(tx, HumanIdSchema.parse(only.humanId))
        if (human === undefined) throw new Error('identity without a human')
        return { outcome: 'attached', human }
      }
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
    return { outcome: 'created', human }
  })
}

/**
 * What happened when a signed-in person tried to attach a provider (`#574`).
 *
 * The three refusals are separate outcomes rather than one `false`, because
 * they are three different sentences a person needs to read — and because
 * *belongs to somebody else* is the one where being wrong hands over an
 * account, so it must not be reachable by falling through a boolean.
 */
export type ConnectOutcome =
  /** Attached. Either door now reaches this person. */
  | { readonly outcome: 'attached'; readonly human: Human }
  /** They already hold it. Not an error and not a duplicate row. */
  | { readonly outcome: 'already-theirs'; readonly human: Human }
  /** It is another person's identity. Nothing is touched, on either account. */
  | { readonly outcome: 'taken'; readonly human?: undefined }

/**
 * Attach a provider identity to a person who is already signed in (`#574`).
 *
 * **The deliberate path, and it exists because the automatic one cannot cover
 * the common case.** {@link findOrCreateHuman} attaches when the verified
 * addresses match; a GitHub account with a private address gives the Colony no
 * address at all, and a person may simply use two. Neither is an edge case
 * among developers, so there is a path that asks rather than infers.
 *
 * **Whose session it is decides, and the address plays no part.** The caller has
 * already established who is signed in; this attaches to *that* person. That is
 * the whole difference from the automatic path, and it is why this one needs no
 * verified-address condition: the person is standing there.
 *
 * **`taken` is the branch to read.** An identity already belonging to somebody
 * else is refused with nothing written on either account — not moved, not
 * shared, not silently ignored. A version of this that reassigned the row would
 * let anybody who can complete a provider handover walk into the account that
 * identity already reaches.
 */
export async function connectIdentity(
  db: Database,
  humanId: HumanId,
  identity: ProviderIdentity,
): Promise<ConnectOutcome> {
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

    if (existing !== undefined && existing.humanId !== humanId) {
      return { outcome: 'taken' }
    }

    if (existing !== undefined) {
      // Theirs already. The address is still refreshed, for the same reason a
      // returning sign-in refreshes it: a person who made their address public
      // since last time should not stay unreachable.
      await tx
        .update(humanIdentities)
        .set({ email: identity.email })
        .where(
          and(
            eq(humanIdentities.provider, identity.provider),
            eq(humanIdentities.subject, identity.subject),
          ),
        )

      const human = await readHuman(tx, humanId)
      if (human === undefined) throw new Error('identity without a human')
      return { outcome: 'already-theirs', human }
    }

    await tx
      .insert(humanIdentities)
      .values({
        humanId,
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
      })
      .onConflictDoNothing()

    const human = await readHuman(tx, humanId)
    // The caller held a session for this person a moment ago. If they are gone
    // now, the account was deleted mid-flight and there is nothing to attach to.
    if (human === undefined) throw new Error('identity without a human')
    return { outcome: 'attached', human }
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
    /**
     * Parsed rather than passed through, the way every other enum array in this
     * package is: the column is a Postgres enum array and the driver hands back
     * plain strings, so a value the schema no longer knows would otherwise reach
     * a caller typed as if it did.
     */
    roles: row.roles.map((value) => HumanRoleSchema.parse(value)),
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

/** What a human role grant or revocation did. */
export type HumanRoleChange =
  | { readonly outcome: 'changed' }
  /** They already held it, or already did not. Nothing was written, audit row included. */
  | { readonly outcome: 'unchanged' }
  /** No such person. */
  | { readonly outcome: 'unknown-human' }

/**
 * Grant or withdraw a role a *person* holds, with the record of who did it
 * (`#485`).
 *
 * **Modelled on `setStewardRole` rather than on `setRole`**, and the difference
 * is the audit row: this writes one, because a permission is not derivable and
 * the array on `humans.roles` says who holds the role and nothing about who
 * decided that. `authority_events.subject_human_id` is the column that record
 * goes in.
 *
 * **The change and its record commit together**, which is the rule
 * `recordAuthorityEvent` states: an act that committed while its audit row did
 * not is an act with no record, and *the record exists* is the whole point of
 * the table.
 *
 * **`unchanged` writes nothing at all**, audit row included. An audit that fills
 * with rows where nothing was granted is an audit nobody reads.
 *
 * **The actor may be null**, and that is not an oversight: the bootstrap grant
 * at startup has no actor, because the deploy host set a variable rather than
 * anybody inside the Colony deciding something. `actor_id` is already nullable
 * for erasure, and a null there reads as *the Colony itself*, which is exactly
 * what a deploy-time grant is.
 */
export async function setHumanRole(
  db: Database,
  command: {
    readonly humanId: HumanId
    readonly role: HumanRole
    readonly hold: boolean
    readonly actorId?: string | undefined
  },
): Promise<HumanRoleChange> {
  return await db.transaction(async (tx) => {
    const [person] = await tx
      .select({ id: humans.id })
      .from(humans)
      .where(eq(humans.id, command.humanId))
      .limit(1)

    if (person === undefined) return { outcome: 'unknown-human' as const }

    // Cast for the reason `grantRoles` casts: the column is `human_role[]` and a
    // bound parameter arrives as text, so `array_append(human_role[], text)`
    // matches no signature and fails at runtime rather than at build time.
    const held = sql`${command.role}::human_role = any(${humans.roles})`

    const rows = await tx
      .update(humans)
      .set({
        roles: command.hold
          ? sql`array_append(${humans.roles}, ${command.role}::human_role)`
          : sql`array_remove(${humans.roles}, ${command.role}::human_role)`,
      })
      .where(and(eq(humans.id, command.humanId), command.hold ? sql`not ${held}` : held))
      .returning({ id: humans.id })

    if (rows.length === 0) return { outcome: 'unchanged' as const }

    await tx.insert(authorityEvents).values({
      actorId: command.actorId ?? null,
      action: command.hold ? 'role-granted' : 'role-revoked',
      subjectHumanId: command.humanId,
      // `role` stays null: see the column's own note. One human role means
      // `subject_human_id` being set already says which one.
    })

    return { outcome: 'changed' as const }
  })
}

/**
 * Give the identity named by `BOOTSTRAP_MAINTAINER_SUBJECT` the `maintainer`
 * role, if it exists and does not hold it (`#485`).
 *
 * ## Why a variable rather than a migration
 *
 * `authority.ts` records how the first steward arrived: *"the first steward
 * comes from a migration."* This departs from that on purpose. That migration
 * named an agent UUID the Colony minted; this one would have to name **a
 * person's GitHub identity, in a public repository, permanently and unremovably
 * in git history**. `#429` gives a person the right to have everything about
 * them deleted, and a migration is the one place that right cannot reach.
 *
 * The variable is set on the deploy host, which is where the other things
 * naming a person already live.
 *
 * ## It is still automatic
 *
 * The maintainer runs no SQL and clicks nothing: the grant is applied on the
 * first start after the variable is set, and every start after that finds the
 * role already held and does nothing.
 *
 * ## An unset variable is the ordinary case
 *
 * Answers `not-configured` and the process starts normally with nobody holding
 * the role. **This must never be declared in `required-env.ts` or in an
 * `ai.kolonie.required-env` label**: `kolonie-infra#42` makes `preflight_env()`
 * refuse a deploy whose host cannot supply a declared name, so declaring this
 * one would break every deployment that has no maintainer to bootstrap —
 * including every future one, since the variable is only ever needed once.
 * `CONSOLE_SENDER_ADDRESS` is the precedent and states the same trade.
 *
 * A subject that names no identity is also not an error. A host may carry the
 * variable before the person has ever signed in, and the answer is to do
 * nothing and say so — the next start after they sign in grants it.
 */
export const BOOTSTRAP_MAINTAINER_SUBJECT_VAR = 'BOOTSTRAP_MAINTAINER_SUBJECT'

export type BootstrapOutcome =
  | { readonly outcome: 'granted'; readonly humanId: HumanId }
  /** The identity holds it already. Every start after the first. */
  | { readonly outcome: 'already-held'; readonly humanId: HumanId }
  /** No identity carries that subject yet — they have not signed in. */
  | { readonly outcome: 'no-such-identity' }
  /**
   * More than one identity carries it, so it names nobody in particular.
   *
   * Nothing is granted. A stored subject is not always provider-prefixed — see
   * the note on the query — and the one outcome that must not happen is a
   * person given authority because their numeric id collided with somebody
   * else's.
   */
  | { readonly outcome: 'ambiguous-subject' }
  /** The variable is unset or blank, which is what most deployments look like. */
  | { readonly outcome: 'not-configured' }

export async function bootstrapMaintainer(
  db: Database,
  subject: string | undefined,
): Promise<BootstrapOutcome> {
  if (subject === undefined || subject.trim() === '') return { outcome: 'not-configured' }

  /**
   * Matched on `subject` alone rather than on `(provider, subject)` — **and it
   * is not assumed to be unique.**
   *
   * This originally said an Auth0 `sub` carries its own provider prefix,
   * `github|12345`, and is therefore unique across providers on its own.
   * **Measured against production on 2026-08-07 while setting the variable for
   * the first time: the stored subject is a bare numeric id**, seven characters
   * and no prefix. So the justification was false for the data it was written
   * about, and a bare id can collide across providers — a Google account whose
   * numeric id happens to match a GitHub one is not far-fetched.
   *
   * Asking for a second variable is still the wrong trade: two names for one
   * identity is two chances to get it wrong, and the collision is rare. So the
   * ambiguity is **refused rather than resolved arbitrarily** — two rows means
   * nobody is granted anything and the start says so. Granting to whichever row
   * the planner returned first is the only outcome that could hand a person
   * authority over somebody else's Colony.
   */
  const identities = await db
    .select({ humanId: humanIdentities.humanId })
    .from(humanIdentities)
    .where(eq(humanIdentities.subject, subject.trim()))
    .limit(2)

  if (identities.length === 0) return { outcome: 'no-such-identity' }
  if (identities.length > 1) return { outcome: 'ambiguous-subject' }

  const [identity] = identities
  if (identity === undefined) return { outcome: 'no-such-identity' }

  const humanId = HumanIdSchema.parse(identity.humanId)
  const change = await setHumanRole(db, { humanId, role: 'maintainer', hold: true })

  return change.outcome === 'changed'
    ? { outcome: 'granted', humanId }
    : { outcome: 'already-held', humanId }
}
