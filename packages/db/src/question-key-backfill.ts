import { sql } from 'drizzle-orm'
import type { Database } from './client.js'

/**
 * The migration that gave every stored question the key an answer names it by.
 *
 * Named so the test can read it and check that the statement below is still the
 * statement that shipped — the same arrangement `raster-rename.ts`,
 * `skill-backfill.ts`, `coin-unwind.ts` and `credit-rename.ts` use, and for the
 * same reason: a migration cannot import TypeScript, and a statement nobody can
 * test is a statement nobody can trust.
 */
export const QUESTION_KEY_BACKFILL_MIGRATION = '0162_a_question_carries_its_key.sql'

/**
 * Give a keyless stored question a key, so the row can be read again (`#542`).
 *
 * **This runs once, against exactly one row, and it is written to be replayable
 * anyway.** The row is `767f79cd` — the first quest paid for in SOL, written on
 * 2026-08-07 with two questions carrying a `prompt`, a `required` and no `key`.
 * `TaskSchema` refuses that shape on the way out of `toTask`, so
 * `kolonie.tasks.list`, `kolonie.tasks.get`, `kolonie.quests.list`,
 * `kolonie.quests.read` and the console's agent page answered `internal` for
 * every citizen until it was found.
 *
 * **A key is invented rather than the question being dropped**, because both
 * alternatives destroy what a sponsor paid for and neither is recoverable. A
 * positional key is exactly as informative as the position it comes from, which
 * is the honest amount: nothing was lost that the row still held.
 *
 * **Why this is safe to do in place, and why it would not have been later.**
 * `quest_answers` is keyed by `question_key`, so renaming a question after an
 * answer exists orphans the answer. No answer had been submitted against this
 * quest — it was unreadable, which is the whole complaint — so the window in
 * which a positional key is free is now. That is the argument for repairing in
 * the same migration that adds `tasks_questions_carry_a_key` rather than filing
 * it as follow-up work: after the constraint, no row can arrive in this state,
 * and before it, waiting only makes the repair lossy.
 *
 * **Guarded rather than blanket.** The `WHERE` is the constraint's own predicate,
 * so a row whose keys are all well-formed is not rewritten, and a second run
 * matches nothing.
 */
export const BACKFILL_QUESTION_KEYS_SQL = `UPDATE "tasks"
SET "questions" = (
	SELECT jsonb_agg(
		CASE
			WHEN question.value -> 'key' IS NOT NULL
				AND jsonb_typeof(question.value -> 'key') = 'string'
				AND question.value ->> 'key' ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
			THEN question.value
			ELSE question.value || jsonb_build_object('key', 'question-' || question.ordinality)
		END
		ORDER BY question.ordinality
	)
	FROM jsonb_array_elements("tasks"."questions") WITH ORDINALITY AS question(value, ordinality)
)
WHERE jsonb_array_length("tasks"."questions") <> jsonb_array_length(
	jsonb_path_query_array("tasks"."questions", '$[*] ? (@.key like_regex "^[a-z0-9]+(-[a-z0-9]+)*$")')
);`

/**
 * Run the backfill against a database.
 *
 * Exported because it is what the test drives, and because it is the statement a
 * maintainer restoring a backup would want to run against rows the migration
 * never saw.
 */
export async function backfillQuestionKeys(db: Database): Promise<void> {
  await db.execute(sql.raw(BACKFILL_QUESTION_KEYS_SQL))
}
