import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { logDefects } from '../schema/index.js'

/**
 * What the Colony has already noticed in its own logs (`#407`).
 *
 * **Every function here is keyed on a signature the detector computed, and none
 * takes a title, a body or anything a model wrote.** Detection is deterministic
 * and the model only writes prose; if a model's output could reach this table,
 * a bad afternoon at a vendor would change what the Colony thinks it has
 * already seen.
 */

/** One signature, as the runner reads it back. */
export interface KnownDefect {
  readonly signature: string
  readonly service: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly occurrences: number
  readonly issueUrl: string | null
  readonly issueFiledAt: string | null
  readonly lastCommentAt: string | null
  readonly quietClosedAt: string | null
  readonly regressions: number
}

/** What one tick saw of one signature. */
export interface SeenDefect {
  readonly signature: string
  readonly service: string
  /** Lines observed in this window. Added to the running total. */
  readonly occurrences: number
}

/**
 * Record that these signatures were seen, and answer what the Colony knew about
 * each one **before** this call.
 *
 * **The before-state is the return value, and that is the whole shape of it.** A
 * caller that recorded first and read afterwards could never tell a signature it
 * has just met from one it has been watching for a week — which is exactly the
 * distinction that decides whether to file. One statement does both, so two
 * ticks racing cannot both conclude *new*.
 */
export async function recordSeenDefects(
  db: Database,
  seen: readonly SeenDefect[],
): Promise<Map<string, KnownDefect | undefined>> {
  if (seen.length === 0) return new Map()

  const before = await db
    .select()
    .from(logDefects)
    .where(
      sql`${logDefects.signature} in ${sql.raw(`(${seen.map((s) => `'${s.signature.replaceAll("'", "''")}'`).join(', ')})`)}`,
    )

  const known = new Map<string, KnownDefect | undefined>(
    before.map((row) => [row.signature, asKnown(row)]),
  )

  await db
    .insert(logDefects)
    .values(
      seen.map((defect) => ({
        signature: defect.signature,
        service: defect.service,
        occurrences: defect.occurrences,
      })),
    )
    .onConflictDoUpdate({
      target: logDefects.signature,
      set: {
        lastSeenAt: sql`now()`,
        // Added rather than replaced: the column is *how many lines this has
        // ever accounted for*, and a window's count is this window's share.
        occurrences: sql`${logDefects.occurrences} + excluded.occurrences`,
      },
    })

  for (const defect of seen)
    if (!known.has(defect.signature)) known.set(defect.signature, undefined)

  return known
}

/**
 * Say that an issue was filed for this signature.
 *
 * **Written after the issue exists, never before.** A row claiming an issue that
 * GitHub refused would silence the signature forever — the next tick would read
 * it as already filed and say nothing, which is the one failure mode of a
 * dedupe key.
 */
export async function recordDefectIssue(
  db: Database,
  signature: string,
  issueUrl: string,
  regression = false,
): Promise<void> {
  await db
    .update(logDefects)
    .set({
      issueUrl,
      issueFiledAt: sql`now()`,
      ...(regression ? { regressions: sql`${logDefects.regressions} + 1` } : {}),
    })
    .where(eq(logDefects.signature, signature))
}

/** Say the detector has just noted a recurrence on the open issue. */
export async function recordDefectComment(db: Database, signature: string): Promise<void> {
  await db
    .update(logDefects)
    .set({ lastCommentAt: sql`now()` })
    .where(eq(logDefects.signature, signature))
}

/**
 * Say the detector closed this signature's issue after the quiet window
 * (`kolonie-docs#561`).
 *
 * **Written after GitHub confirmed the close, never before** — the same rule
 * `recordDefectIssue` follows, for the same reason: a row claiming a closure
 * that did not happen would send the next recurrence down the reopen path
 * against an issue that is still open.
 */
export async function recordDefectQuietClosed(db: Database, signature: string): Promise<void> {
  await db
    .update(logDefects)
    .set({ quietClosedAt: sql`now()` })
    .where(eq(logDefects.signature, signature))
}

/**
 * Clear the quiet-close marker after the same issue was reopened.
 *
 * **Only this and nothing else.** The issue URL does not change on a reopen —
 * that is the whole point of holding the identity — and `lastCommentAt` is not
 * touched, because the reopen comment is not a recurrence note on an open
 * issue; the two counters answer different questions.
 */
export async function recordDefectReopened(db: Database, signature: string): Promise<void> {
  await db
    .update(logDefects)
    .set({ quietClosedAt: null })
    .where(eq(logDefects.signature, signature))
}

/**
 * How many issues this detector has filed in the last day.
 *
 * The per-day cap reads this. On the row rather than in the process, for
 * `deferrals`' reason: a count a redeploy forgets is a cap that a redeploy
 * lifts, and a runner that restarts during an incident is exactly when the cap
 * matters.
 */
export async function defectIssuesFiledSince(db: Database, since: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(logDefects)
    .where(and(isNotNull(logDefects.issueFiledAt), gte(logDefects.issueFiledAt, since)))

  return Number(row?.count ?? 0)
}

/** One signature, or nothing. For a caller that has a key and wants the row. */
export async function readDefect(
  db: Database,
  signature: string,
): Promise<KnownDefect | undefined> {
  const [row] = await db
    .select()
    .from(logDefects)
    .where(eq(logDefects.signature, signature))
    .limit(1)

  return row === undefined ? undefined : asKnown(row)
}

/** The signatures filed most recently, for a reader that wants the shape of it. */
export async function recentDefects(db: Database, limit = 50): Promise<readonly KnownDefect[]> {
  const rows = await db.select().from(logDefects).orderBy(desc(logDefects.lastSeenAt)).limit(limit)

  return rows.map(asKnown)
}

function asKnown(row: typeof logDefects.$inferSelect): KnownDefect {
  return {
    signature: row.signature,
    service: row.service,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    occurrences: Number(row.occurrences),
    issueUrl: row.issueUrl,
    issueFiledAt: row.issueFiledAt,
    lastCommentAt: row.lastCommentAt,
    quietClosedAt: row.quietClosedAt,
    regressions: row.regressions,
  }
}
