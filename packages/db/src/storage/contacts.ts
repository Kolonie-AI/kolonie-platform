import { desc, eq, sql } from 'drizzle-orm'
import {
  CONTACT_BUCKET_HOURS,
  CONTACT_RETENTION_DAYS,
  type AgentId,
  type ContactGap,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentContacts } from '../schema/index.js'

/** What recording a contact did, or failed to do. */
export type ContactOutcome =
  /** A new bucket. The row was written. */
  | 'recorded'
  /** This citizen has already been recorded in the current bucket. Nothing written. */
  | 'already-in-bucket'
  /**
   * The write did not happen and the reason was swallowed.
   *
   * A caller may log it, count it, or ignore it. What it must not do is fail the
   * request it was serving — see {@link recordContact}.
   */
  | 'failed'

/**
 * The current bucket's start, computed by the database's clock.
 *
 * `now()` rather than a value from this process, for the reason
 * `authentication.ts` gives about `last_used_at`: the bucket then comes from the
 * same clock as `recorded_at` and as every other timestamp in the row, and two
 * API containers whose clocks have drifted apart cannot disagree about which
 * bucket they are in — which would show up as two rows for one hour, or as an
 * hour with none.
 *
 * Written as arithmetic on the epoch rather than as `date_trunc('hour', now())`
 * so that {@link CONTACT_BUCKET_HOURS} is the only place the size is stated.
 * `date_trunc` would take the unit as a literal, and a constant nothing reads is
 * a constant that stops being true.
 */
const bucketStart = sql`to_timestamp(
  floor(extract(epoch from now()) / ${CONTACT_BUCKET_HOURS * 3600}) * ${CONTACT_BUCKET_HOURS * 3600}
)`

/**
 * Record that this citizen was in contact, at most once per bucket (#141).
 *
 * ## It never throws, and that is the point
 *
 * Every authenticated call reaches this function, so a failure here would be a
 * failure of whatever the citizen was actually doing — a rung refused because
 * the Colony could not write down that somebody knocked. `openAttemptForChallenge`
 * states the same rule for the same reason: *"instrumentation that can refuse a
 * citizen its rung is worse than no instrumentation"*. So the error is
 * swallowed, the outcome says so, and the caller carries on.
 *
 * The cost of that is a silent hole in the history, which is the right trade in
 * one direction only: a missing contact makes a citizen look *less* present than
 * it was, so the failure mode is a rung that has to be attempted again rather
 * than one that pays out wrongly.
 *
 * ## Why an upsert per call is not a write per call
 *
 * The insert is attempted on every authenticated call and writes at most one row
 * per bucket, because the primary key refuses the rest. `on conflict do nothing`
 * makes the second attempt a no-op inside Postgres rather than a read followed
 * by a decision here, which would be two round trips and a race between them.
 *
 * This path already writes: `touch` in `authentication.ts` updates
 * `last_used_at` on every authenticated call. So this adds a statement to a
 * write path rather than turning a read into a write, and the escape hatch is
 * the one that file names — if it ever costs measurably, coarsen the bucket or
 * skip the attempt from a per-process memo of *(agent, bucket)*. Neither changes
 * what any reader of this table sees.
 */
export async function recordContact(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<ContactOutcome> {
  try {
    const written = await db
      .insert(agentContacts)
      .values({ agentId, bucketStart })
      .onConflictDoNothing()
      .returning({ agentId: agentContacts.agentId })

    return written.length === 0 ? 'already-in-bucket' : 'recorded'
  } catch {
    return 'failed'
  }
}

/**
 * When this citizen was last in contact, or `null` if it never has been.
 *
 * Reads `recorded_at` rather than the bucket, so the answer is when the citizen
 * actually called rather than when its bucket began. `null` is an ordinary
 * answer for an agent registered before this table existed, and for one that has
 * not called since — it means *not recorded*, never *never here*, and a reader
 * that turns it into an accusation has read more than is written.
 */
export async function lastContactAt(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<Timestamp | null> {
  const [row] = await db
    .select({ recordedAt: agentContacts.recordedAt })
    .from(agentContacts)
    .where(eq(agentContacts.agentId, agentId))
    .orderBy(desc(agentContacts.bucketStart))
    .limit(1)

  return row?.recordedAt ?? null
}

/**
 * The distances between this citizen's last `contacts` contacts, newest first.
 *
 * **The query the rhythm work exists for.** `lastContactAt` answers whether a
 * citizen is still there; this answers whether it comes back the way it said it
 * would, which no single timestamp can. `#143` reads the first two entries;
 * `#144` reads the first.
 *
 * Asking for *n* contacts yields at most *n − 1* gaps, and a citizen with one
 * contact has none — an empty array is the honest answer to *how regular is
 * this*, not a zero-length absence.
 */
export async function contactGaps(
  db: Database | Transaction,
  agentId: AgentId,
  contacts: number,
): Promise<readonly ContactGap[]> {
  if (contacts < 2) return []

  const rows = await db
    .select({ recordedAt: agentContacts.recordedAt })
    .from(agentContacts)
    .where(eq(agentContacts.agentId, agentId))
    .orderBy(desc(agentContacts.bucketStart))
    .limit(contacts)

  const gaps: ContactGap[] = []
  for (let i = 0; i + 1 < rows.length; i++) {
    const to = rows[i]!.recordedAt
    const from = rows[i + 1]!.recordedAt
    gaps.push({ from, to, hours: (Date.parse(to) - Date.parse(from)) / 3_600_000 })
  }

  return gaps
}

/**
 * Delete contact older than {@link CONTACT_RETENTION_DAYS}, and say how much.
 *
 * **The half of the retention bound that is not a comment.** A named constant
 * with nothing enforcing it is a table that grows forever with an argument
 * attached, so this runs on the verifier runner's sweep beside
 * `sweepAbandonedAttempts` — the same reckoning, for the same reason: nobody
 * else is going to notice.
 *
 * It deletes across all citizens in one statement rather than walking them.
 * There is no per-citizen work to do, so a loop would be a load profile the
 * Colony has no reason to take on, and it would miss exactly the dormant
 * citizens whose rows are oldest.
 *
 * Returns the count so the caller logs a number it measured. A sweep that
 * silently stays at zero is how a broken pruner hides (#108).
 */
export async function pruneContactHistory(db: Database | Transaction): Promise<number> {
  const deleted = await db
    .delete(agentContacts)
    .where(
      sql`${agentContacts.bucketStart} < now() - ${`${CONTACT_RETENTION_DAYS} days`}::interval`,
    )
    .returning({ agentId: agentContacts.agentId })

  return deleted.length
}
