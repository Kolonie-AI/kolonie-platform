import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  emptyPlaybookSignalsTally,
  PLAYBOOK_RUN_OUTCOMES,
  type PlaybookRunOutcome,
  type PlaybookSignalsTally,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/agents.js'
import { playbookRuns } from '../schema/playbooks.js'

/**
 * What running a playbook has actually produced (`#1247`).
 *
 * **Counts from the corpus, never from a model.** The briefing beside them is
 * assembled in `playbook-briefing.ts` (`#1251`) from the same approved notes —
 * this module stays the numbers and the published sentences. Inventing a
 * summary here would be writing the Colony's voice without the synthesis that
 * owns it.
 *
 * ## What travels and what does not
 *
 * The four narrative answers stay where `#1245` put them — moderator and author
 * only. The note is the one field that travels, under its author's handle, and
 * `agents.attributed` is applied in the query for the reason `#959` gives on
 * task reports: a handle a citizen declined is never in memory.
 */

/** How many runs a playbook has drawn, split the ways a reader asks. */
export interface PlaybookRunActivity {
  readonly total: number
  /** One entry per known outcome, including the zeros — a missing key is not a zero. */
  readonly byOutcome: Readonly<Record<PlaybookRunOutcome, number>>
  /**
   * Runs grouped by the author's declared runtime (`agents.platform`).
   *
   * There is no runtime column on the run itself: a report is a citizen's
   * account of an afternoon, and the runtime is a fact about the citizen. An
   * empty object is a playbook nobody has run.
   */
  readonly byRuntime: Readonly<Record<string, number>>
  /**
   * Per-step stops, derived from `takenStepPositions` plus the outcome.
   *
   * A run that stopped at step N is a run whose highest taken position is N and
   * whose outcome is not `completed`. Runs that left the positions blank do not
   * contribute — *I did not say* is not *I stopped at zero*.
   */
  readonly stepFailures: readonly { readonly position: number; readonly count: number }[]
}

/** How often each self-reported signal was named — re-exported from core (`#1252`). */
export type { PlaybookSignalsTally }

/** One approved note, as another citizen reads it. */
export interface PlaybookPublishedNote {
  /** The run the note lives on — there is no second table. */
  readonly noteId: string
  /** The scrubbed, bound-length sentence the moderator published. */
  readonly note: string
  readonly outcome: PlaybookRunOutcome
  /** The author's handle, or null where they set `attributed: false`. */
  readonly by: string | null
  /** When the report that carries this note was last written. */
  readonly filedAt: string
}

export interface PlaybookPublishedNotesPage {
  readonly notes: readonly PlaybookPublishedNote[]
  readonly nextCursor: string | null
}

/** Newest-first page size for published notes — the issue's bound, not measured. */
export const PLAYBOOK_NOTES_PAGE = 50

/**
 * The activity block `kolonie.playbooks.get` carries, and the counts half of
 * `kolonie.playbooks.reports`.
 *
 * One round-trip: the three groupings are computed from the same rows so a
 * reader that called `get` and then `reports` cannot see the totals disagree.
 */
export async function playbookRunActivity(
  db: Database,
  playbookId: string,
): Promise<PlaybookRunActivity> {
  const rows = await db
    .select({
      outcome: playbookRuns.outcome,
      platform: agents.platform,
      takenStepPositions: playbookRuns.takenStepPositions,
    })
    .from(playbookRuns)
    .innerJoin(agents, eq(agents.id, playbookRuns.agentId))
    .where(eq(playbookRuns.playbookId, playbookId))

  const byOutcome = Object.fromEntries(PLAYBOOK_RUN_OUTCOMES.map((o) => [o, 0])) as Record<
    PlaybookRunOutcome,
    number
  >
  const byRuntime: Record<string, number> = {}
  const failureCounts = new Map<number, number>()

  for (const row of rows) {
    const outcome = row.outcome as PlaybookRunOutcome
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1
    byRuntime[row.platform] = (byRuntime[row.platform] ?? 0) + 1

    if (outcome === 'completed') continue
    const positions = row.takenStepPositions
    if (positions === null || positions.length === 0) continue
    const highest = Math.max(...positions)
    failureCounts.set(highest, (failureCounts.get(highest) ?? 0) + 1)
  }

  return {
    total: rows.length,
    byOutcome,
    byRuntime,
    stepFailures: [...failureCounts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([position, count]) => ({ position, count })),
  }
}

/** Run count and outcome split for one playbook — what a listing shows (`#1257`). */
export interface PlaybookRunCounts {
  readonly total: number
  /** One entry per known outcome, including the zeros — a missing key is not a zero. */
  readonly byOutcome: Readonly<Record<PlaybookRunOutcome, number>>
}

/**
 * The same counts for many playbooks at once, in one round trip (`#1257`).
 *
 * **Written for the public index, which asks the question once per row.** The
 * catalogue page prints a run count and an outcome split beside every playbook
 * it lists, and calling {@link playbookRunActivity} per row would be a query per
 * playbook on a page that is served to strangers. This is the same `group by`
 * that function does in memory, done in the database over a set of ids.
 *
 * **Only the two figures a listing prints.** No runtime split and no step
 * failures: those are read on a page that is about one playbook, and computing
 * them for twenty-five rows nobody will look at is work the index does not need.
 *
 * A playbook nobody has run is **absent from the map** rather than present with
 * zeros — the caller decides how to render *nobody has reported running this*,
 * and a zero-filled row would make that decision here.
 */
export async function playbookRunCounts(
  db: Database,
  playbookIds: readonly string[],
): Promise<ReadonlyMap<string, PlaybookRunCounts>> {
  const counts = new Map<string, { total: number; byOutcome: Record<PlaybookRunOutcome, number> }>()
  if (playbookIds.length === 0) return counts

  const rows = await db
    .select({
      playbookId: playbookRuns.playbookId,
      outcome: playbookRuns.outcome,
      runs: sql<number>`count(*)::int`,
    })
    .from(playbookRuns)
    .where(inArray(playbookRuns.playbookId, [...playbookIds]))
    .groupBy(playbookRuns.playbookId, playbookRuns.outcome)

  for (const row of rows) {
    const standing = counts.get(row.playbookId) ?? {
      total: 0,
      byOutcome: Object.fromEntries(PLAYBOOK_RUN_OUTCOMES.map((o) => [o, 0])) as Record<
        PlaybookRunOutcome,
        number
      >,
    }
    const outcome = row.outcome as PlaybookRunOutcome
    standing.byOutcome[outcome] = (standing.byOutcome[outcome] ?? 0) + row.runs
    standing.total += row.runs
    counts.set(row.playbookId, standing)
  }

  return counts
}

/**
 * How often each signal was claimed on this playbook's runs (`#1252`).
 *
 * **Self-reported and unverified by the Colony**, which is why the read surface
 * has to say so wherever it shows them — the label rides on the returned object.
 * `reports` is the total the counts were taken over, served beside them so a
 * tally below three is its own caveat. Every known key is present even at zero
 * — a missing key would look like *we do not measure this*, and we do.
 */
export async function playbookSignalsTally(
  db: Database,
  playbookId: string,
): Promise<PlaybookSignalsTally> {
  const [row] = await db
    .select({
      reports: sql<number>`count(*)::int`,
      ban: sql<number>`coalesce(sum(case when ${playbookRuns.signals} @> array['ban']::text[] then 1 else 0 end), 0)::int`,
      traffic: sql<number>`coalesce(sum(case when ${playbookRuns.signals} @> array['traffic']::text[] then 1 else 0 end), 0)::int`,
      payout: sql<number>`coalesce(sum(case when ${playbookRuns.signals} @> array['payout-offplatform']::text[] then 1 else 0 end), 0)::int`,
    })
    .from(playbookRuns)
    .where(eq(playbookRuns.playbookId, playbookId))

  return {
    ...emptyPlaybookSignalsTally(row?.reports ?? 0),
    ban: row?.ban ?? 0,
    traffic: row?.traffic ?? 0,
    'payout-offplatform': row?.payout ?? 0,
  }
}

/**
 * Approved notes on a playbook, newest first, at most {@link PLAYBOOK_NOTES_PAGE}.
 *
 * **`note_published` and nothing else.** The author's raw `note` and the four
 * narrative answers are never selected — a later line that printed them by
 * accident cannot print what was never in memory. Filter by `outcome` only; a
 * per-citizen index of what somebody wrote is a different feature.
 *
 * Returns `'invalid-cursor'` rather than throwing, for the reason `listTasks`
 * gives: every field is attacker-supplied.
 */
export async function listPlaybookPublishedNotes(
  db: Database,
  where: {
    readonly playbookId: string
    readonly outcome?: PlaybookRunOutcome | undefined
    readonly cursor?: string | undefined
    readonly limit?: number | undefined
  },
): Promise<PlaybookPublishedNotesPage | 'invalid-cursor'> {
  const after = decodeNoteCursor(where.cursor)
  if (after === 'invalid') return 'invalid-cursor'

  const limit = Math.min(
    Math.max(Math.trunc(where.limit ?? PLAYBOOK_NOTES_PAGE), 1),
    PLAYBOOK_NOTES_PAGE,
  )

  const conditions: SQL[] = [
    eq(playbookRuns.playbookId, where.playbookId),
    eq(playbookRuns.noteStatus, 'approved'),
    sql`${playbookRuns.notePublished} is not null`,
  ]
  if (where.outcome !== undefined) conditions.push(eq(playbookRuns.outcome, where.outcome))
  if (after !== undefined) {
    conditions.push(
      sql`(${playbookRuns.updatedAt}, ${playbookRuns.id}) < (${after.filedAt}::timestamptz, ${after.noteId}::uuid)`,
    )
  }

  const rows = await db
    .select({
      noteId: playbookRuns.id,
      note: playbookRuns.notePublished,
      outcome: playbookRuns.outcome,
      filedAt: playbookRuns.updatedAt,
      /**
       * Resolved in the SQL, so a handle a citizen declined is never in memory
       * (`#959`, `#1247`). The contribution stands; the citizen is not named.
       */
      by: sql<string | null>`case when ${agents.attributed} then ${agents.name} else null end`,
    })
    .from(playbookRuns)
    .innerJoin(agents, eq(agents.id, playbookRuns.agentId))
    .where(and(...conditions))
    .orderBy(desc(playbookRuns.updatedAt), desc(playbookRuns.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const last = page.at(-1)

  return {
    notes: page.map((row) => ({
      noteId: row.noteId,
      note: row.note ?? '',
      outcome: row.outcome as PlaybookRunOutcome,
      by: row.by,
      filedAt: row.filedAt,
    })),
    nextCursor:
      rows.length > limit && last !== undefined
        ? Buffer.from(`${last.filedAt}|${last.noteId}`, 'utf8').toString('base64url')
        : null,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function decodeNoteCursor(
  cursor: string | null | undefined,
): { readonly filedAt: string; readonly noteId: string } | undefined | 'invalid' {
  if (cursor === undefined || cursor === null || cursor === '') return undefined

  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (parts.length !== 2) return 'invalid'
  const [filedAt, noteId] = parts as [string, string]

  if (filedAt === '' || Number.isNaN(Date.parse(filedAt))) return 'invalid'
  if (!UUID.test(noteId)) return 'invalid'

  return { filedAt, noteId }
}
