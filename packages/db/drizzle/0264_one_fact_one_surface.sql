ALTER TABLE "provider_reports" ADD COLUMN "migrated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "from_provider_report" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Every verdict already filed becomes the walk that now carries it (#1036).
--
-- The author is preserved, the time it was noted becomes the time the walk ran,
-- and `from_provider_report` marks the row for the two things that need to tell
-- it from a walk somebody described: the briefing, and the withdrawal this alias
-- is still allowed to make. The mapping is the issue's own table and is written
-- once more in `packages/core/src/account/report-as-walk.ts`, which is what the
-- live path reads — the sentences below are that file's, to the character.
--
-- `abandoned` carries no wall and no recipe, because
-- `account_walks_wall_only_on_a_refusal` says a wall is a refusal's and this is
-- not one.
INSERT INTO "account_walks" (
  "agent_id", "kind", "provider", "direction", "started_at", "finished_at",
  "outcome", "wall", "recipe", "prose_status", "scrubbed_prose", "from_provider_report"
)
SELECT
  r."agent_id",
  r."kind",
  r."provider",
  r."direction",
  r."noted_at",
  r."noted_at",
  CASE WHEN r."outcome" = 'abandoned' THEN 'abandoned' ELSE 'refused' END,
  -- The citizen's own sentence wins where it wrote one; the mapping's sentence
  -- says what the enum said, which the wall kind already carries.
  CASE WHEN r."outcome" = 'abandoned' THEN NULL ELSE coalesce(r."reason", m."sentence") END,
  CASE WHEN r."outcome" = 'abandoned' THEN NULL ELSE jsonb_build_object(
    'walls', jsonb_build_array(jsonb_build_object('kind', 'other', 'symptom', m."sentence"))
  ) END,
  -- A sentence a citizen wrote keeps the verdict it already had; a row that
  -- carries only the Colony's own sentence has nothing waiting to be read.
  (CASE
     WHEN r."outcome" <> 'abandoned' AND r."reason" IS NOT NULL THEN r."reason_status"::text
     ELSE 'approved'
   END)::"public"."moderation_status",
  CASE
    WHEN r."outcome" <> 'abandoned'
     AND r."reason_status" = 'approved'
     AND r."scrubbed_reason" IS NOT NULL
    THEN jsonb_build_object('wall', r."scrubbed_reason")
  END,
  true
FROM "provider_reports" r
LEFT JOIN (VALUES
  ('no-service',
   'Nothing answered at this provider — no working service behind the name at all.'),
  ('cannot-do-the-job',
   'The provider’s own documentation says the account cannot do what this kind is for, so signup was never attempted.'),
  ('signup-refused',
   'The provider turned the walker down at signup. Which of the nine walls it was is not on this record: it was filed as a provider report, which never asked.'),
  ('never-provisioned',
   'Signup appeared to succeed and the account never worked.')
) AS m("outcome", "sentence") ON m."outcome" = r."outcome"::text
WHERE r."migrated_at" IS NULL;--> statement-breakpoint

-- Marked, never deleted, and out of every count from here on. The row is the
-- only thing left to check the conversion against on the day the mapping turns
-- out to have been wrong for one of them.
UPDATE "provider_reports" SET "migrated_at" = now() WHERE "migrated_at" IS NULL;

-- `provider_recipes.walls` is deliberately not rebuilt here.
--
-- The published aggregate is `publishWalls`'s, and `republishWalls` is the one
-- caller — TypeScript, unreachable from a migration. Reproducing it in SQL is
-- possible and would be a second implementation of the grouping, which is the
-- two-records-of-one-fact this issue exists to remove. Nothing regresses by
-- leaving it: a provider report never fed `walls` in the first place, so no
-- entry loses anything it published yesterday. Each affected entry picks the
-- converted walks up at the next walk or report against it, which is what
-- `republishWalls` is for.
--
-- **Neither is the entry's status.** Going forward a converted refusal marks its
-- provider `refused`, because it is a walk and that is what a refused walk with a
-- wall does — but recomputing it here would mark a shelf of historical entries
-- closed in one statement, on evidence that was filed when this surface
-- explicitly did not publish a verdict (#904). A citizen reading `refused` is
-- reading somebody's finding about a door; a hundred of them appearing at once
-- because a migration ran is the Colony publishing a finding nobody walked. So
-- the rows are converted and the shelf is left to move one honest walk at a time.
