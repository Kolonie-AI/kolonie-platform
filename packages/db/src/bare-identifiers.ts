/**
 * Find, in rendered SQL, a comparison inside a subquery where one side is an
 * unqualified column reference (`#311`).
 *
 * ## The defect this names
 *
 * Drizzle renders `${table.column}` bare — without its table — when the
 * statement has exactly one table in scope and the fragment sits in a select
 * field. `#183` found what that costs:
 *
 * ```sql
 * (select count(*) from "task_attempts" where "session_id" = "id")
 * ```
 *
 * Both sides resolve against `task_attempts`, the predicate becomes
 * `task_attempts.session_id = task_attempts.id`, and the count comes back a
 * confident zero. Nothing errors and nothing warns.
 *
 * **One unqualified side is enough**, which is the half `#311` measured. A
 * subquery that names its inner table properly and leaves the *outer* reference
 * bare is correct only for as long as the inner table has no column of that
 * name:
 *
 * ```sql
 * (select name from agents where agents.id = "agent_id")
 * ```
 *
 * That is right today because `agents` has no `agent_id`. Adding one — an
 * ordinary thing to do — would bind it inward, and every form would name the
 * wrong citizen from a query that still returns a row. It is the same accident
 * `heldSkillsSql` was rescued from, one table over.
 *
 * ## Why this reads SQL and not source
 *
 * `bare-identifiers.test.ts` reads source text, and says in its own header that
 * text cannot decide: whether a fragment renders bare depends on the query it is
 * embedded in, which is usually in another function and sometimes in another
 * file. This function needs no call site because it is handed the rendering.
 *
 * It runs from `connectForTests`, over every statement the test suite executes,
 * so a fragment is judged in every shape any test puts it in — including shapes
 * nobody thought to list. What it cannot see is a call site no test reaches;
 * that gap is the text check's half of the job, and neither replaces the other.
 */

/**
 * Words that look like a column and are not one.
 *
 * Two kinds, and both were found by running this against the whole suite rather
 * than by listing what seemed likely. The constants — `x = true`, `x = null` —
 * are the obvious half. The other half is a keyword that *begins an expression*:
 * `t.type = case when …` reads as a comparison against something called `case`,
 * and the data migration in `0040` is where that turned up.
 *
 * Function calls need no entry: `x > now()` is excluded by its parenthesis.
 */
const NOT_A_COLUMN = new Set([
  'true',
  'false',
  'null',
  'unknown',
  'any',
  'all',
  'some',
  'current_date',
  'current_time',
  'current_timestamp',
  'localtime',
  'localtimestamp',
  'default',
  'case',
  'when',
  'then',
  'else',
  'end',
  'not',
  'exists',
  'distinct',
  'interval',
  'array',
  'select',
])

/**
 * One operand: a parameter, a literal, a number, or a possibly-qualified name.
 *
 * A cast tail (`::numeric`) is not consumed, so `$1::numeric` matches as `$1`
 * and is classified as a parameter — which is the answer that matters, because
 * a comparison against a parameter cannot resolve against an outer table.
 */
const OPERAND = String.raw`(?:\$\d+|'[^']*'|\d+(?:\.\d+)?|(?:"[a-z_][a-z0-9_$]*"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"[a-z_][a-z0-9_$]*"|[a-z_][a-z0-9_$]*))?)`

const COMPARISON = new RegExp(
  String.raw`(${OPERAND})\s*(=|<>|!=|>=|<=|<|>)\s*(${OPERAND})(\s*\()?`,
  'giu',
)

/** Is this operand a column reference at all — as opposed to a value? */
const isColumnReference = (operand: string): boolean => {
  const text = operand.trim()
  if (text.startsWith('$') || text.startsWith("'")) return false
  if (/^\d/u.test(text)) return false
  return !NOT_A_COLUMN.has(text.replaceAll('"', '').toLowerCase())
}

/** Does it carry its table — `agents.id`, `"agents"."id"` — or not? */
const isQualified = (operand: string): boolean => operand.includes('.')

/**
 * The parenthesised spans that begin `(select`, outermost first.
 *
 * Nested subqueries are inside the span their parent returns, so they are
 * scanned as part of it and need no separate pass.
 */
function subquerySpans(sql: string): readonly string[] {
  const spans: string[] = []

  for (const opening of sql.matchAll(/\(\s*select\b/giu)) {
    let depth = 0
    for (let index = opening.index; index < sql.length; index += 1) {
      if (sql[index] === '(') depth += 1
      else if (sql[index] === ')') {
        depth -= 1
        if (depth === 0) {
          spans.push(sql.slice(opening.index, index + 1))
          break
        }
      }
    }
  }

  return spans
}

/**
 * The first comparison inside a subquery with an unqualified column on one side,
 * or `undefined` when there is none.
 *
 * Both operands must be column references. `agent_id = $1` is a bound parameter
 * and cannot resolve outward; `status = 'passed'` is a literal. Neither is this
 * defect, and flagging them would flag most of the schema.
 */
export function bareOuterReference(sql: string): string | undefined {
  for (const span of subquerySpans(sql)) {
    for (const [, left, operator, right, callParenthesis] of span.matchAll(COMPARISON)) {
      // `x = coalesce(...)`: the right-hand side is a call, not a column.
      if (callParenthesis !== undefined) continue
      if (left === undefined || right === undefined) continue
      if (!isColumnReference(left) || !isColumnReference(right)) continue
      if (isQualified(left) && isQualified(right)) continue

      return `${left} ${operator} ${right}`
    }
  }

  return undefined
}

/**
 * Fail the query that rendered it, at the call site that issued it.
 *
 * Wired into `connectForTests` as postgres.js's `debug` hook rather than into
 * `createDatabase`, so nothing about this reaches a running service: it is a
 * property of the test arrangement, checked where the tests connect.
 */
export function assertNoBareOuterReference(sql: string): void {
  const found = bareOuterReference(sql)
  if (found === undefined) return

  throw new Error(
    `A subquery compares "${found}", and one side carries no table name (#311).\n\n` +
      `Drizzle renders \`\${table.column}\` bare in a select field of a single-table ` +
      `query, and an unqualified name resolves against the innermost table that ` +
      `declares it. That is a wrong answer with no error attached: the query still ` +
      `returns a row.\n\n` +
      `Write both sides out with their table names, the way heldSkillsSql does, and ` +
      `alias the inner table. See bare-identifiers.ts.\n\n` +
      `The statement:\n${sql}`,
  )
}
