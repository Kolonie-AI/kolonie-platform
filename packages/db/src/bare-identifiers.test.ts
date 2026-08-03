import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * **A subquery in a select-field position may not interpolate a column** (#183).
 *
 * Drizzle's rendering of `${table.column}` inside a `sql` template depends on
 * where the template is used, and that difference is the whole defect. Measured
 * against this schema on 2026-08-01:
 *
 * ```
 * in a where/join:   coalesce("task_attempts"."task_id", "task_reports"."task_id")
 * in a select field: (select count(*) from "task_attempts" where "session_id" = "id")
 * ```
 *
 * Qualified in the first, **bare in the second**. So the same expression is safe
 * in a `where` and silently wrong as a selected field: `"session_id" = "id"`
 * resolves both against `task_attempts`, the predicate becomes
 * `task_attempts.session_id = task_attempts.id`, false for every row, and the
 * count comes back a confident zero. Nothing errors and nothing warns.
 *
 * `#183` records this being caught in `sessions.ts` by a test that had
 * attributed an attempt and expected to find it. Writing this check found a
 * second one: `heldSkillsSql` compiled to `where "agent_id" = "id"` and was
 * correct only because `agent_skills` has a composite key and no `id` of its
 * own, so the bare `"id"` fell outward to `agents.id`. Adding an `id` to that
 * table — an ordinary thing to do — would have made every agent in the Colony
 * report holding no skills, from a query that still returns a row.
 *
 * **The rule this checks.** A template that contains a subquery and names
 * columns of more than one table is either wrong or one edit away from it. That
 * is broader than *select-field position*, which is what actually decides it,
 * because position is not visible from the text — so the two `where`-position
 * fragments that are safe today are listed below with what they were measured to
 * render. Listing them is the point: one line and an argument, against a defect
 * whose whole cost is a wrong answer nobody sees.
 *
 * Same technique as `required-env.test.ts` and the session check in
 * `storage/sessions.test.ts`, and for the same reason: the failure is invisible
 * from any single file, so no test that exercises a code path can find it.
 */
describe('a subquery never interpolates columns of two tables', () => {
  /**
   * Safe today, and each entry is a measurement rather than an assumption.
   *
   * Both sit in a `where`, where Drizzle qualifies:
   *
   * - `tasks.ts` — `passedBy`, rendering `"submissions"."task_id" = "tasks"."id"`
   * - `guidance.ts` — the revisability guard, rendering
   *   `"task_attempts"."id" = "task_reports"."attempt_id"`
   *
   * If either moves into a select field it has to come off this list, and this
   * check is what will say so.
   *
   * **`#175` adds one**:
   *
   * - `submissions.ts` — the capacity count in `createSubmission`. Two tables,
   *   but the correlation is to **parameters** and not to an outer column:
   *   `"submissions"."task_id" = $1`, `"task_attempts"."agent_id" <> $3`. There
   *   is no outer query for an identifier to be resolved against, so the failure
   *   mode this check is about cannot arise.
   *
   * ## Two entries were cleared on a measurement that was wrong (#246)
   *
   * `isFull` in `tasks.ts` and `reservedBy` in `escrow.ts` were both listed here
   * as *renders every identifier qualified*, both in a select-field position,
   * both argued from a rendering. **Neither rendering was real.** Re-measured on
   * 2026-08-03 through the same dialect, `isFull` came out
   *
   * ```sql
   * (select count(*) from "submissions" where "task_id" = "id" and "status" = 'passed')
   * ```
   *
   * — bare on both sides, the exact defect at the top of this file, in the exact
   * position this file says to look at. A quest with capacity never read as full
   * for as long as that stood.
   *
   * **The check was right and the exemption was wrong**, which is the failure
   * mode of an allowlist and worth stating plainly: a list of measured
   * exceptions is only as good as the measurements, and an entry that says
   * *measured* reads exactly like one that was reasoned about. The words in this
   * file that survived unchanged — *"render it and read the SQL"* — are the ones
   * that were not followed.
   *
   * Both are now written with literal table names and an aliased inner table, so
   * they no longer interpolate a column at all and have left this list rather
   * than moved down it. That is the durable answer: an expression that names no
   * table variable cannot be qualified wrongly, whatever position it ends up in.
   *
   * **`#176` adds three**, all in `quests.ts` and all the same fragment twice
   * over: *has the moderator judged this quest since its text last changed*.
   * Two sit in a `where` and one in an `exists` inside a `where`; all three
   * render every identifier qualified, because each column is written as
   * `${table.column}`:
   *
   * ```
   * exists (select 1 from "quest_moderations"
   *          where "quest_moderations"."task_id" = "tasks"."id"
   *            and "quest_moderations"."decision" = 'approved'
   *            and "quest_moderations"."created_at" >= "tasks"."text_revised_at")
   * ```
   *
   * The correlation to `tasks` is the point of the fragment rather than an
   * accident of scope, which is exactly the shape this check recommends: name
   * the outer column instead of letting it be resolved.
   *
   * **`#177` adds a fourth to `quests.ts`**, the same shape one table over —
   * *has the scrub reached this report yet*, in the `where` of the moderation
   * queue. Rendered:
   *
   * ```
   * not exists (select 1 from "quest_answers"
   *              where "quest_answers"."submission_id" = "submissions"."id")
   * ```
   *
   * **`#221` adds a fifth to `quests.ts`**: *has a steward read this verdict
   * yet*, in the `where` of the audit queue. Same shape and same rendering —
   * `"quest_audits"."submission_id" = "submissions"."id"`, both written out.
   *
   * All counts were measured by rendering the fragment and reading the SQL — the
   * `quests.ts` five and the two re-measurements above on 2026-08-03, the rest
   * on 2026-08-02. The two that were wrong are gone from the list rather than
   * corrected in it, because they no longer name a table variable.
   */
  const MEASURED_SAFE: Readonly<Record<string, number>> = {
    'tasks.ts': 1,
    'guidance.ts': 1,
    'submissions.ts': 1,
    'quests.ts': 5,
  }

  /**
   * `sql` template literals, with their contents.
   *
   * Backtick-to-backtick, which is enough because none of these templates
   * contains a nested template or an escaped backtick. A parser would be the
   * thorough answer and more machinery than the rule deserves — if this stops
   * matching, the check has outgrown its shape and should be replaced rather
   * than patched.
   */
  const sqlTemplates = (source: string): readonly string[] =>
    [...source.matchAll(/sql(?:<[^>]*>)?`([^`]*)`/g)].map((match) => match[1] ?? '')

  /**
   * Every table variable the schema declares, e.g. `taskAttempts`.
   *
   * **Read from the schema rather than guessed from the shape**, because
   * `${input.reportId}` and `${taskReports.id}` are the same three tokens and
   * only one of them is a column. The first is an ordinary JavaScript property,
   * bound as a parameter and always safe; the second is rendered as SQL text. A
   * check that could not tell them apart would flag a dozen correct lines and be
   * switched off within the month.
   */
  const schemaTables = async (): Promise<ReadonlySet<string>> => {
    const directory = fileURLToPath(new URL('./schema/', import.meta.url))
    const names = new Set<string>()

    for (const entry of await readdir(directory)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
      const source = await readFile(`${directory}${entry}`, 'utf8')
      for (const match of source.matchAll(/export const (\w+) = pgTable\(/g)) {
        names.add(match[1] as string)
      }
    }

    return names
  }

  /** `${something.something}`, kept only where the something is a real table. */
  const tablesNamed = (template: string, tables: ReadonlySet<string>): ReadonlySet<string> =>
    new Set(
      [...template.matchAll(/\$\{\s*(\w+)\s*\.\s*\w+\s*\}/g)]
        .map((match) => match[1] as string)
        .filter((name) => tables.has(name)),
    )

  it('so nothing outside the measured-safe list does', async () => {
    const root = fileURLToPath(new URL('.', import.meta.url))
    const tables = await schemaTables()

    // The schema is the whole basis of the check, so an empty set would make it
    // pass by finding nothing rather than by there being nothing.
    expect(tables.size).toBeGreaterThan(10)

    const found: Record<string, number> = {}

    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${directory}${entry.name}`
        if (entry.isDirectory()) {
          await walk(`${path}/`)
          continue
        }
        // This file quotes the defect it is written about.
        if (!entry.name.endsWith('.ts') || entry.name === 'bare-identifiers.test.ts') continue

        const source = await readFile(path, 'utf8')
        for (const template of sqlTemplates(source)) {
          if (!/\bselect\b/i.test(template)) continue
          if (tablesNamed(template, tables).size > 1) {
            found[entry.name] = (found[entry.name] ?? 0) + 1
          }
        }
      }
    }

    await walk(root)

    // A new entry is not automatically wrong — but it has to be measured and
    // argued for above, which is the point. Render it and read the SQL: if the
    // identifiers come out bare, alias the inner table and write the outer
    // reference out, the way `heldSkillsSql` and `currentSessionIdSql` do.
    expect(found).toEqual(MEASURED_SAFE)
  })

  /**
   * The check catches the shape it is written for.
   *
   * Asserted against the exact line from #183 rather than an invented one, so a
   * later loosening of the pattern is measured against the defect rather than
   * against a test author's idea of it.
   */
  it('catches the line that produced the defect', async () => {
    const tables = await schemaTables()
    const defect =
      'sql`(select count(*) from ${taskAttempts} where ${taskAttempts.sessionId} = ${agentSessions.id})`'

    const [template] = sqlTemplates(defect)

    expect(/\bselect\b/i.test(template ?? '')).toBe(true)
    // Two tables, both rendered bare, both resolving against the first — which
    // is the entire defect.
    expect(tablesNamed(template ?? '', tables)).toEqual(new Set(['taskAttempts', 'agentSessions']))
  })

  it('leaves alone a bound value, a single-table subquery, and a JavaScript property', async () => {
    const tables = await schemaTables()
    const bound = 'sql`(select s.id from agent_sessions s where s.agent_id = ${agentId})`'
    const oneTable =
      'sql`(select count(*) from ${reportFeedback} where ${reportFeedback.reportId} = ${id})`'
    // The false positive the schema lookup exists to prevent: `report` is an
    // object in scope, not a table, so `${report.taskId}` is bound.
    const jsProperty =
      'sql`(select 1 from ${taskAttempts} where ${taskAttempts.taskId} = ${report.taskId})`'

    expect(tablesNamed(sqlTemplates(bound)[0] ?? '', tables).size).toBe(0)
    expect(tablesNamed(sqlTemplates(oneTable)[0] ?? '', tables).size).toBe(1)
    expect(tablesNamed(sqlTemplates(jsProperty)[0] ?? '', tables).size).toBe(1)
  })
})
