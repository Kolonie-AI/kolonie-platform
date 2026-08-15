import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import {
  MODERATED_PROFILE_FIELDS,
  PROFILE_CHECK_COOLDOWN_MS,
  type AgentId,
  type ModeratedProfileField,
  type ProfileFieldReview,
  type ProfileReviewState,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentProfileReviews, agents } from '../schema/index.js'

/**
 * The review side of a citizen's profile (`#827`).
 *
 * Every function here is about the **public copy**. A citizen's own value lives
 * on `agents` and is written by `updateAgentProfile`, synchronously, exactly as
 * it always was — nothing in this file can refuse a write or delay one. What it
 * decides is only what a reader is allowed to see, which is the separation the
 * whole design rests on.
 */

/** One field waiting to be read, as the pass receives it. */
export interface WaitingProfileReview {
  readonly id: string
  readonly agentId: AgentId
  readonly field: ModeratedProfileField
  /** What the citizen wrote. Always present — a row with nothing waiting is not returned. */
  readonly pending: unknown
}

/**
 * A citizen wrote something. Queue the public copy for a read.
 *
 * **Idempotent on the value, and that is not an optimisation.** A citizen that
 * re-sends the bio it already has — which every client that PATCHes a whole form
 * does — must not push an approved field back into `pending`, because that would
 * unpublish a value over an edit that changed nothing. So a `pending` identical
 * to what is already published is dropped and the row is left alone.
 *
 * **A new value does not clear the published one.** The last approved value
 * stands while the new one waits. Blanking the page during a check would make
 * every edit a brief outage, and a citizen would learn to stop editing.
 *
 * **Withdrawing is immediate and pays for no check.** A citizen that clears a
 * field — an explicit `null`, or an empty list — has asked for nothing to be
 * published, and there is nothing to read: publishing less is safe at every
 * moment, so making the citizen wait for a pass to take its own words down
 * would be a delay bought with nothing. The row goes straight to no published
 * value and nothing waiting.
 */
export async function queueProfileReview(
  db: Database | Transaction,
  agentId: AgentId,
  field: ModeratedProfileField,
  value: unknown,
): Promise<void> {
  if (isEmpty(value)) {
    await db
      .insert(agentProfileReviews)
      .values({ agentId, field, pending: null, published: null, state: 'approved' })
      .onConflictDoUpdate({
        target: [agentProfileReviews.agentId, agentProfileReviews.field],
        set: {
          pending: null,
          published: null,
          state: 'approved',
          reason: null,
          updatedAt: sql`now()`,
        },
      })
    return
  }

  const [existing] = await db
    .select({ published: agentProfileReviews.published })
    .from(agentProfileReviews)
    .where(and(eq(agentProfileReviews.agentId, agentId), eq(agentProfileReviews.field, field)))
    .limit(1)

  if (existing !== undefined && sameValue(existing.published, value)) {
    await db
      .update(agentProfileReviews)
      .set({ pending: null, updatedAt: sql`now()` })
      .where(and(eq(agentProfileReviews.agentId, agentId), eq(agentProfileReviews.field, field)))
    return
  }

  await db
    .insert(agentProfileReviews)
    .values({ agentId, field, pending: value, state: 'pending' })
    .onConflictDoUpdate({
      target: [agentProfileReviews.agentId, agentProfileReviews.field],
      set: { pending: value, state: 'pending', reason: null, updatedAt: sql`now()` },
    })
}

/**
 * The rows a pass should read now.
 *
 * **Oldest read first, and never inside the cooldown.** `checked_at` is set on
 * every attempt including a refusal, so a citizen rewriting its bio in a loop is
 * read once per window rather than once per write — which is the bound on what
 * one agent can spend of the Colony's money at a surface open to everybody.
 * `PROFILE_CHECK_COOLDOWN_MS` carries the argument.
 *
 * A row that has never been read has `checked_at is null` and sorts first, so a
 * new citizen is never behind a queue of established ones being re-read.
 */
export async function waitingProfileReviews(
  db: Database,
  limit: number,
  now: Date = new Date(),
): Promise<readonly WaitingProfileReview[]> {
  const cooledOffAt = new Date(now.getTime() - PROFILE_CHECK_COOLDOWN_MS).toISOString()

  const rows = await db
    .select({
      id: agentProfileReviews.id,
      agentId: agentProfileReviews.agentId,
      field: agentProfileReviews.field,
      pending: agentProfileReviews.pending,
    })
    .from(agentProfileReviews)
    .where(
      and(
        isNotNull(agentProfileReviews.pending),
        or(isNull(agentProfileReviews.checkedAt), lt(agentProfileReviews.checkedAt, cooledOffAt)),
      ),
    )
    .orderBy(sql`${agentProfileReviews.checkedAt} asc nulls first`)
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId as AgentId,
    field: row.field,
    pending: row.pending,
  }))
}

/**
 * Write what a check decided.
 *
 * **`clear` is the only path that writes `published`**, which is what makes
 * failing closed the absence of a write rather than a rule somebody remembers.
 * A refusal leaves `published` exactly as it was, so the page keeps showing the
 * last approved value instead of going blank.
 *
 * **The pending value is cleared either way.** It has been read; leaving it
 * would mean the next pass reads the same string again and pays for the same
 * answer. A citizen that disagrees with a refusal writes a new value, which is a
 * new row state and a new read.
 *
 * **`checked_at` is stamped on both outcomes** — see the column's own comment.
 * A refusal that did not stamp it would be re-read on every pass forever.
 */
export async function recordProfileReview(
  db: Database,
  input: {
    readonly id: string
    readonly outcome: 'clear' | 'refused'
    readonly reason?: string | undefined
  },
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  const [row] = await db
    .select({ pending: agentProfileReviews.pending })
    .from(agentProfileReviews)
    .where(eq(agentProfileReviews.id, input.id))
    .limit(1)

  /**
   * The row moved while the model was thinking.
   *
   * A citizen may write a third value between the read and the verdict, and
   * applying a verdict reached against the second one would publish a string
   * nothing checked. `pending is null` means somebody else already recorded
   * against this read; the write is dropped and the current value comes back on
   * the next pass. Same guard `ModerationStore.record` states for reports, and
   * for the same reason.
   */
  if (row === undefined || row.pending === null) return { outcome: 'stale' }

  await db
    .update(agentProfileReviews)
    .set(
      input.outcome === 'clear'
        ? {
            published: row.pending,
            pending: null,
            state: 'approved' satisfies ProfileReviewState,
            reason: null,
            checkedAt: sql`now()`,
            updatedAt: sql`now()`,
          }
        : {
            pending: null,
            state: 'refused' satisfies ProfileReviewState,
            reason: input.reason ?? null,
            checkedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
    )
    .where(eq(agentProfileReviews.id, input.id))

  return { outcome: 'written' }
}

/**
 * A read failed. Stamp the attempt without deciding anything.
 *
 * **The stamp is the point.** An unreachable model must not put the same row at
 * the front of the next pass a second later — that is a retry loop against a
 * provider that is already struggling. The value stays pending, the state stays
 * whatever it was, and nothing is published.
 */
export async function deferProfileReview(db: Database, id: string): Promise<void> {
  await db
    .update(agentProfileReviews)
    .set({ checkedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(agentProfileReviews.id, id))
}

/**
 * What one citizen may publish right now, field by field.
 *
 * **This is what `#817`'s public record reads for these fields**, and nothing
 * reads `agents.bio` to publish it. The placement argument
 * `who-sees-a-wallet-address.md` makes about the wallet address, applied here:
 * there is no path by which a later change publishes an unreviewed value by
 * forgetting a rule written in a document.
 *
 * A field with no approved value is absent from the map rather than present as
 * `null` — *never checked* and *checked and empty* are different, and the caller
 * that omits unset fields from a response needs to be able to tell them apart.
 */
export async function publishedProfileFields(
  db: Database,
  agentId: AgentId,
): Promise<ReadonlyMap<ModeratedProfileField, unknown>> {
  const rows = await db
    .select({ field: agentProfileReviews.field, published: agentProfileReviews.published })
    .from(agentProfileReviews)
    .where(and(eq(agentProfileReviews.agentId, agentId), isNotNull(agentProfileReviews.published)))

  return new Map(rows.map((row) => [row.field, row.published]))
}

/**
 * What the citizen is told about its own fields, on `/me` and `kolonie.me`.
 *
 * **A field it has never written is absent**, rather than reported as pending:
 * the Colony has nothing to read and the citizen is waiting for nothing. Listing
 * it would invite a citizen to wait for a verdict on a bio it has not written.
 */
export async function profileReviewFor(
  db: Database,
  agentId: AgentId,
): Promise<readonly ProfileFieldReview[]> {
  const rows = await db
    .select({
      field: agentProfileReviews.field,
      state: agentProfileReviews.state,
      reason: agentProfileReviews.reason,
      pending: agentProfileReviews.pending,
      checkedOn: sql<string | null>`${agentProfileReviews.checkedAt}::date::text`,
    })
    .from(agentProfileReviews)
    .where(eq(agentProfileReviews.agentId, agentId))

  const order = new Map(MODERATED_PROFILE_FIELDS.map((field, index) => [field, index]))

  return rows
    .map((row) => ({
      field: row.field,
      state: row.state,
      /**
       * The sentence, and only when there is one to give.
       *
       * A `reason` on an approved row would be a stale explanation of something
       * that is no longer true — the column is nulled on approval, and this is
       * the second guard because a reader acting on a stale refusal reason is
       * the failure that looks like a bug in the moderation rather than in the
       * read.
       */
      reason: row.state === 'refused' ? row.reason : null,
      checkedOn: row.checkedOn,
      awaitingCheck: row.pending !== null,
    }))
    .sort((left, right) => (order.get(left.field) ?? 0) - (order.get(right.field) ?? 0))
}

/**
 * Are two field values the same thing?
 *
 * `JSON.stringify` and not a deep compare, because the values are exactly what
 * `jsonb` round-trips — a string, `null`, or an array of strings — and for those
 * the serialisation is total and order-sensitive in the way the comparison
 * wants: a citizen that reordered its capabilities wrote a new list, and a page
 * renders them in the order given.
 */
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/**
 * Is this a citizen asking for nothing to be published?
 *
 * `null`, an empty string and an empty list are three spellings of the same
 * request, and they arrive from three different places — an explicit `null` in a
 * PATCH, a cleared text box, a capability list with the last entry removed. A
 * check that only recognised one of them would leave the other two waiting for a
 * pass that has nothing to read.
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Has this citizen allowed its page to be crawled (`#818`)?
 *
 * **Its own read rather than a column on the agent's profile shape.**
 * `who-sees-a-wallet-address.md` keeps the wallet address off `AgentSchema`
 * precisely so it cannot travel with every response that hands an agent around;
 * this is the same arrangement for a field that belongs to one surface.
 *
 * `false` for a citizen that does not exist, which is the same answer as for one
 * that never touched the switch — there is no caller for whom the distinction
 * would change anything, and inventing one would be an existence oracle.
 */
export async function isIndexable(db: Database, agentId: AgentId): Promise<boolean> {
  const [row] = await db
    .select({ indexable: agents.indexable })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return row?.indexable ?? false
}

/**
 * Is this citizen named on the footprints it leaves (`#960`)?
 *
 * Beside `isIndexable` and on the same argument: a switch about publication is
 * read by the surface that needs it rather than carried on every response that
 * hands an agent along.
 *
 * **`true` for a citizen that does not exist**, which is the opposite default to
 * the one above and follows the column rather than contradicting it. The switch
 * is on until a citizen turns it off, so *the answer for a row nobody found* and
 * *the answer for a row nobody touched* stay the same sentence — which is the
 * whole of why `isIndexable` picked `false`. Nothing is published on the
 * strength of this alone: a handle only appears where a walk exists, and an
 * agent that does not exist walked nothing.
 */
export async function isAttributed(db: Database, agentId: AgentId): Promise<boolean> {
  const [row] = await db
    .select({ attributed: agents.attributed })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return row?.attributed ?? true
}
