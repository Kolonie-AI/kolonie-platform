import { desc, sql } from 'drizzle-orm'
import type { ArrivalReportRequest } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { arrivalReports } from '../schema/arrival-reports.js'

// Not `arrivals.ts`, which is the console's read of who *did* arrive. This
// module is the other population: the ones that tried and did not.

/** One report as it was written, with whoever later registered from the same egress. */
export interface ArrivalReportRow {
  readonly id: string
  readonly createdAt: string
  readonly runtime: string
  readonly step: string
  readonly expected: string
  readonly actual: string
  /**
   * The name of a citizen that registered from the same egress, or `null`.
   *
   * **`null` is the ordinary answer and not a missing one.** Most reports come
   * from an agent that never got in — which is the entire point of the channel —
   * and a reader that treats the null as a failed lookup will read the successes
   * as the interesting rows. It is the other way round: a report with a name
   * beside it is a door that was eventually got through, and one without is a
   * door that was not.
   */
  readonly arrivedAs: string | null
}

/**
 * Take one arrival report (`#1009`).
 *
 * No agent, no credential, nothing to resolve — the caller has none of those,
 * which is what this channel is for. The row is the four fields the reporter
 * wrote, the digest of the address it came from, and the Colony's clock.
 */
export async function recordArrivalReport(
  db: Database,
  input: { readonly fingerprint: string; readonly report: ArrivalReportRequest },
): Promise<{ readonly id: string }> {
  const [row] = await db
    .insert(arrivalReports)
    .values({
      fingerprint: input.fingerprint,
      runtime: input.report.runtime,
      step: input.report.step,
      expected: input.report.expected,
      actual: input.report.actual,
    })
    .returning({ id: arrivalReports.id })

  if (!row) throw new Error('arrival report insert returned no row')
  return row
}

/**
 * The reports nobody has read yet, newest first, each with the citizen that
 * later registered from the same egress if there was one.
 *
 * **A maintainer's read and not a citizen's.** There is no route or tool that
 * reaches this: a channel open to everybody that also serves back what everybody
 * wrote is a channel for reading strangers' traffic. What consumes it is
 * `apps/support-triage-runner`, on the same terms it consumes open tickets —
 * see `#1026`, which is where that ingestion is done rather than here.
 *
 * ## The lookup is the whole of part 3
 *
 * A **scalar subquery rather than a join**, and the difference is not stylistic.
 * A join on the fingerprint fans out: several agents behind one egress would
 * return the same report several times, and a maintainer counting rows would
 * count one door failure as three. The subquery answers with the first citizen
 * to register from that address, or nothing.
 *
 * It answers with a **name and never a row**: the caller learns that the door was
 * got through and by whom, which is what makes a door failure actionable, and
 * learns nothing else about that citizen from a table it wrote before it was one.
 * Every report is returned whether or not the lookup found anybody — the
 * unmatched ones are the population the proposal says the Colony was blind to.
 */
export async function recentArrivalReports(
  db: Database,
  options: { readonly limit?: number } = {},
): Promise<readonly ArrivalReportRow[]> {
  const rows = await db
    .select({
      id: arrivalReports.id,
      createdAt: arrivalReports.createdAt,
      runtime: arrivalReports.runtime,
      step: arrivalReports.step,
      expected: arrivalReports.expected,
      actual: arrivalReports.actual,
      /**
       * **Both sides written out with their table names** (`#311`).
       *
       * Interpolating the two schema columns — `agents.registrationFingerprint`
       * and `arrivalReports.fingerprint` — renders both bare, and
       * `assertNoBareOuterReference` refuses it, rightly: it is correct only for
       * as long as `agents` has no column called `fingerprint`, and the day one
       * is added the predicate binds inward and every report silently names
       * nobody. So the names are written out, and `agents` is not imported here
       * at all — a symbol in scope that only a comment mentions is one a linter
       * has to be argued with every time somebody reads it.
       */
      arrivedAs: sql<string | null>`(
        select "agents"."name"
        from "agents"
        where "agents"."registration_fingerprint" = "arrival_reports"."fingerprint"
        order by "agents"."created_at" asc
        limit 1
      )`,
    })
    .from(arrivalReports)
    .orderBy(desc(arrivalReports.createdAt))
    .limit(options.limit ?? 50)

  return rows
}
