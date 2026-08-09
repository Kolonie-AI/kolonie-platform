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
 * ## Select-field position is half the condition, and `#301` is what showed it
 *
 * **The other half is whether the query joins.** Measured 2026-08-04 through this
 * dialect, the same fragment in the same select-field position, twice:
 *
 * ```
 * .from(browserChallenges)                    where s.agent_id = "agent_id"
 * .from(browserChallenges).innerJoin(agents)  where s.agent_id = "browser_challenges"."agent_id"
 * ```
 *
 * Drizzle omits the table only when the statement has exactly one table in
 * scope. Add any join and every column is qualified, in a select field as
 * anywhere else — so a fragment is bare when it is **in a select field of a
 * single-table query**, and both examples at the top of this file were the
 * single-table case without saying so.
 *
 * **This matters because it is not a refinement, it is the difference between a
 * defect and a false alarm.** `#301` read the `persistenceContext` fragment
 * against *select-field position* alone, concluded that every citizen was being
 * handed the newest session in the Colony, and filed it as a leak. The query
 * joins `agents`, renders qualified, and had always been right. **The correlated
 * half of that condition lives at the call site rather than in the fragment**,
 * which is precisely why the check below reads text and cannot decide.
 *
 * **It also cuts the other way, and that is the direction worth fearing.** A
 * fragment that is safe today because its query joins becomes wrong the moment
 * somebody removes the join for an unrelated reason — and the join is often
 * there for an unrelated reason. That is the argument for writing the outer
 * identifier out, which `#301` reached by a wrong road: an expression naming no
 * table variable cannot be qualified wrongly, whatever the query around it does
 * next.
 *
 * Same technique as `required-env.test.ts` and the session check in
 * `storage/sessions.test.ts`, and for the same reason: the failure is invisible
 * from any single file, so no test that exercises a code path can find it.
 *
 * ## Text cannot decide it, and this is what compensates (`#311`)
 *
 * Everything above is a proxy. The question is *does this fragment render a bare
 * identifier*, and the answer depends on the query it is embedded in — which is
 * usually in another function and sometimes in another file. This check reads one
 * file at a time and cannot see that, and the list below is the price: entries
 * argued rather than decided, two of which were wrong until `#246`.
 *
 * **The half that decides is `bare-identifiers.ts`**, which reads the rendered
 * SQL and is wired into `connectForTests` as postgres.js's `debug` hook. Every
 * statement the suite executes is checked, so a fragment is judged in every shape
 * a test puts it in — including shapes nobody thought to list, and including the
 * hand-written SQL in the data migrations, which this file never looked at. It
 * costs nothing measurable: 46.5 s against 46.7 s and 46.6 s with the hook
 * removed, on 2026-08-04.
 *
 * **Neither half is redundant.** The hook cannot see a call site no test reaches
 * — `extendSceneChallenge` is one, and `#311` rendered it by hand rather than
 * assume — and this file cannot see position. A fragment is safe when both agree.
 *
 * `#311` read all 23 fragments this way. Two were wrong, both in the shape one
 * unqualified side is enough for: `autonomy.ts` rendered
 * `agents.id = "agent_id"` and `standing-hints.ts` rendered `t.id = "task_id"`,
 * each correct only because the inner table had no column of that name. Both are
 * written out now, and neither interpolates a table variable any more.
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
   *
   * **`#559` adds a second to `tasks.ts`**: `equippedBy`, *does this citizen
   * hold every account kind the task names*, in the `where` of the listing.
   * Rendered through this dialect on 2026-08-08, every identifier qualified —
   * including the outer one, which is the correlation the fragment is for:
   *
   * ```
   * not exists (
   *   select 1 from unnest("tasks"."account_kinds") as required(kind)
   *   where not exists (
   *     select 1 from "accounts"
   *     where "accounts"."agent_id" = $1
   *       and "accounts"."kind" = required.kind
   *       and "accounts"."proved"
   *       and "accounts"."for_work"
   *       and "accounts"."status" = 'in-use'))
   * ```
   *
   * The inner correlation is to `required.kind` — a `from` item of the fragment's
   * own making, written out and aliased, so it cannot be resolved outward
   * whatever the query around it does.
   *
   * **`#263` split `quests.ts` into `storage/quests/`** and the five moved with
   * their fragments unchanged — four to `steward.ts` (the moderation clearance,
   * the moderation queue, the scrub queue and the audit queue) and one to
   * `read.ts` (the unmoderated-ids read). Nothing was re-measured, because
   * nothing was rewritten: this list is keyed by file name and the file names
   * are what changed.
   *
   * ## `briefing.ts`, added 2026-08-09 (`#611`)
   *
   * `tasksWithoutReports` asks which tasks nobody has reported on, and a report
   * reaches its task through its attempt — so the fragment names
   * `task_reports`, `task_attempts` and `tasks`. Three tables, which is exactly
   * the shape this rule flags.
   *
   * **It is in a `where`, and it was measured rather than assumed.** Rendered
   * through this dialect on 2026-08-09:
   *
   * ```
   * not exists (
   *   select 1
   *   from "task_reports"
   *   left join "task_attempts" on "task_attempts"."id" = "task_reports"."attempt_id"
   *   where coalesce("task_attempts"."task_id", "task_reports"."task_id") = "tasks"."id")
   * ```
   *
   * Every column qualified, including the outward correlation to `"tasks"."id"`.
   * The statement also joins, which is the second half of the condition `#301`
   * established — Drizzle omits a table only when exactly one is in scope.
   */
  const MEASURED_SAFE: Readonly<Record<string, number>> = {
    'tasks.ts': 2,
    'briefing.ts': 1,
    'guidance.ts': 1,
    'submissions.ts': 1,
    'steward.ts': 4,
    'read.ts': 1,
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
