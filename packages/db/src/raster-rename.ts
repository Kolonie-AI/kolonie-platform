import { sql } from 'drizzle-orm'
import type { Database } from './client.js'

/**
 * The migration that renamed the image rung's skill from `image-gen` to
 * `raster`.
 *
 * Named so the test can read it and check that the statement below is still the
 * statement that shipped — the same arrangement `skill-backfill.ts`,
 * `coin-unwind.ts` and `credit-rename.ts` use, and for the same reason: a
 * migration cannot import TypeScript, and a statement nobody can test is a
 * statement nobody can trust.
 */
export const RASTER_RENAME_MIGRATION = '0079_the_image_rung_certifies_drawing.sql'

/**
 * Rename the skill everywhere a slug is stored (`kolonie-platform#215`).
 *
 * **Three places, and the third is the one that is easy to miss.**
 * `agent_skills.skill` is what a citizen holds; `tasks.grants_skills` is what
 * the rung awards; and `tasks.suggests_skills` is what *other* rungs point at —
 * a soft edge that would otherwise name a skill nothing grants any more, which
 * is invisible rather than loud. `requires_skills` is included for completeness;
 * no task requires this one today and a future one might.
 *
 * **The rename is not a revocation and the data says so.** Both holders keep the
 * row they earned, its `granted_at`, and the `submission_id` that proves it —
 * only the slug in it changes. Measured 2026-08-02 there were two, granted
 * 2026-07-31 15:32 and 2026-08-02 10:46.
 *
 * **`tasks.type` is renamed here as well, and then again by the seed.** That is
 * deliberate redundancy rather than an oversight: `seedAcademyTasks` rewrites the
 * row on every deploy and would fix the type by itself, but migration and seed
 * are separate steps and a database between them must not have a rung whose type
 * no verifier answers to. Both statements are idempotent, so running both costs
 * nothing.
 *
 * **Idempotent by construction.** Every statement is a `WHERE`-guarded update
 * against the old value, so a second run matches nothing. A maintainer restoring
 * a backup can paste it without checking whether it has already been applied.
 */
export const RENAME_IMAGE_GEN_TO_RASTER_SQL = `UPDATE "agent_skills" SET "skill" = 'raster' WHERE "skill" = 'image-gen';
UPDATE "tasks" SET "grants_skills" = array_replace("grants_skills", 'image-gen', 'raster') WHERE 'image-gen' = ANY("grants_skills");
UPDATE "tasks" SET "suggests_skills" = array_replace("suggests_skills", 'image-gen', 'raster') WHERE 'image-gen' = ANY("suggests_skills");
UPDATE "tasks" SET "requires_skills" = array_replace("requires_skills", 'image-gen', 'raster') WHERE 'image-gen' = ANY("requires_skills");
UPDATE "tasks" SET "type" = 'raster' WHERE "type" = 'image-gen';`

/**
 * Run the rename against a database.
 *
 * Exported because it is what the test drives, and because it is the statement a
 * maintainer restoring a backup would want to run against rows the migration
 * never saw.
 */
export async function renameImageGenToRaster(db: Database): Promise<void> {
  await db.execute(sql.raw(RENAME_IMAGE_GEN_TO_RASTER_SQL))
}
