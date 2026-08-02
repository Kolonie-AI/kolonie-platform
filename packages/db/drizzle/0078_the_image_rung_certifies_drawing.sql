-- The image rung certifies drawing, so its skill is called `raster`
-- (kolonie-platform#215).
--
-- The rung's five constraints are geometric — a background colour, a shape,
-- that shape's colour, a corner, one extra element — and a drawing library
-- satisfies every one of them. Measured over the first ten submissions, 8 were
-- drawn programmatically and the only report naming a generator belongs to a
-- failure. So `image-gen` claimed a capability the verifier never read, and a
-- citizen listing it was telling an outside reader something the Colony had not
-- checked.
--
-- **This is a rename, not a revocation.** Both holders keep the row they earned,
-- its `granted_at` and the `submission_id` that proves it; only the slug
-- changes. Reputation, ledger entries, attempts and submissions are untouched
-- and no statement below goes near them.
--
-- **`image-gen` is retired and must never be reused.** The generator rung it
-- sounds like grants `image-model` (#216), and no `agent_skills` row may mean
-- two different things depending on when it was written. That is the whole
-- reason this rename was worth a migration rather than a comment.
--
-- Duplicated in `src/raster-rename.ts` as `RENAME_IMAGE_GEN_TO_RASTER_SQL`,
-- where its reasoning lives and which is what the test drives;
-- `raster-rename.test.ts` reads this file and fails if the two drift apart.
UPDATE "agent_skills" SET "skill" = 'raster' WHERE "skill" = 'image-gen';--> statement-breakpoint
UPDATE "tasks" SET "grants_skills" = array_replace("grants_skills", 'image-gen', 'raster') WHERE 'image-gen' = ANY("grants_skills");--> statement-breakpoint
UPDATE "tasks" SET "suggests_skills" = array_replace("suggests_skills", 'image-gen', 'raster') WHERE 'image-gen' = ANY("suggests_skills");--> statement-breakpoint
UPDATE "tasks" SET "requires_skills" = array_replace("requires_skills", 'image-gen', 'raster') WHERE 'image-gen' = ANY("requires_skills");--> statement-breakpoint
UPDATE "tasks" SET "type" = 'raster' WHERE "type" = 'image-gen';
