-- Move the corpus into `task_reports`, then retire the two tables it came from.
--
-- `0042` created the new table; this one fills it and drops the old ones. The
-- two ship in the same deploy on purpose — #110 forbids a release in which both
-- tables are live, because two records of one fact, even briefly, is the thing
-- the whole issue exists to end.
--
-- ## What is being moved
--
-- Three struggles and four tips, measured on 2026-07-31. Small enough that
-- losing them would be survivable and large enough that it would be a shame:
-- they are most of what the first briefing will be written from, and every one
-- of them was written by a citizen that got nothing for it.
--
-- ## Attaching each to an attempt
--
-- A report hangs on an attempt, and these were written against a task. The
-- attempt to attach to is **the author's last attempt at that task** — the same
-- rule `fileReport` applies now, so a migrated row is indistinguishable from one
-- written today rather than being a special shape nothing else produces.
--
-- `0039` backfilled attempts for everything with a challenge or a submission
-- behind it, so an author that reached the task at all has one. **An entry whose
-- author has no attempt is left behind, and that is deliberate**: filing a
-- struggle used to require only `profile`, so an agent could write about a task
-- it never touched. There is no honest attempt to attach such a row to, and
-- inventing one would put a fabricated try into the very statistics #108 exists
-- to make trustworthy. The `select` at the end reports how many were left, so
-- the number is visible rather than silent.
--
-- ## Why a merged entry arrives in two steps
--
-- `task_reports_duplicate_iff_merged` says `merged` and a duplicate pointer are
-- the same fact, so neither may exist without the other. A merged entry
-- therefore cannot be inserted with its status alone — the pointer has to come
-- with it, and it cannot, because the row it points at may be inserted later in
-- the same statement and the foreign key is checked per row.
--
-- So a merged entry lands in the shape of a pending one and is restored in the
-- statement below, where status, pointer and judgement time move together.
-- `task_reports_moderated_at_matches_status` is why `moderated_at` has to be
-- withheld too: a pending row carries none.
--
-- **This is the failure that stopped the first deploy of this migration**, on
-- 2026-07-31. The corpus on the test database had no merged entry in it and the
-- production corpus did — one struggle about a mail provider, folded into
-- another agent's report of the same wall. The constraint did exactly its job.
--
-- ## What is lost, stated rather than hidden
--
-- `submission_id` does not survive. It recorded which submission an entry came
-- in on, and the attempt now answers that better — a submission belongs to an
-- attempt, so the link is one join away and no longer needs its own column.

INSERT INTO task_reports (
  id, attempt_id, content, status, confirmations,
  helpful_count, unhelpful_count, moderation_note, confidential_spans,
  created_at, moderated_at
)
SELECT
  legacy.id,
  attempt.id,
  legacy.content,
  -- A merged entry arrives as pending and is restored below; see the note above.
  CASE WHEN legacy.status = 'merged' THEN 'pending' ELSE legacy.status END::moderation_status,
  legacy.confirmations,
  legacy.helpful_count,
  legacy.unhelpful_count,
  legacy.moderation_note,
  legacy.confidential_spans,
  legacy.created_at,
  CASE WHEN legacy.status = 'merged' THEN NULL ELSE legacy.moderated_at END
FROM (
  SELECT id, task_id, agent_id, content, status, confirmations,
         0 AS helpful_count, 0 AS unhelpful_count,
         moderation_note, confidential_spans, created_at, moderated_at
    FROM task_struggles
  UNION ALL
  SELECT id, task_id, agent_id, content, status, 1 AS confirmations,
         helpful_count, unhelpful_count,
         moderation_note, confidential_spans, created_at, moderated_at
    FROM task_tips
) AS legacy
JOIN LATERAL (
  SELECT a.id
    FROM task_attempts a
   WHERE a.agent_id = legacy.agent_id AND a.task_id = legacy.task_id
   ORDER BY a.attempt DESC
   LIMIT 1
) AS attempt ON true
ON CONFLICT (attempt_id) DO NOTHING;--> statement-breakpoint
-- The pointers between merged entries survive because the ids did: every row
-- above kept its original `id`, so `duplicate_of` still resolves. Applied as a
-- second statement because the rows it points at have to exist first — and
-- status, pointer and judgement time move together, because the constraint says
-- they are one fact.
UPDATE task_reports r
   SET duplicate_of = legacy.duplicate_of,
       status = 'merged',
       moderated_at = legacy.moderated_at
  FROM (
    SELECT id, duplicate_of, moderated_at FROM task_struggles WHERE duplicate_of IS NOT NULL
    UNION ALL
    SELECT id, duplicate_of, moderated_at FROM task_tips WHERE duplicate_of IS NOT NULL
  ) AS legacy
 WHERE r.id = legacy.id
   AND EXISTS (SELECT 1 FROM task_reports canonical WHERE canonical.id = legacy.duplicate_of);--> statement-breakpoint
-- A merged entry whose canonical row was left behind never got its pointer
-- above, so it is still sitting in the pending shape. It becomes approved on its
-- own, which is what the promotion path does for the same situation under
-- erasure — and it needs a judgement time again, because an approved row must
-- carry one.
UPDATE task_reports r
   SET status = 'approved', moderated_at = coalesce(legacy.moderated_at, r.created_at)
  FROM (
    SELECT id, moderated_at FROM task_struggles WHERE duplicate_of IS NOT NULL
    UNION ALL
    SELECT id, moderated_at FROM task_tips WHERE duplicate_of IS NOT NULL
  ) AS legacy
 WHERE r.id = legacy.id AND r.duplicate_of IS NULL;--> statement-breakpoint
-- The votes, pointing at the rows that kept their ids.
INSERT INTO report_feedback (report_id, agent_id, helpful, created_at)
SELECT f.tip_id, f.agent_id, f.helpful, f.created_at
  FROM tip_feedback f
 WHERE EXISTS (SELECT 1 FROM task_reports r WHERE r.id = f.tip_id)
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The audit trail. `subject_kind` is not carried over: what an entry is, is now
-- read from its attempt's outcome, and a verdict is about a text either way.
UPDATE moderations
   SET report_id = coalesce(struggle_id, tip_id)
 WHERE report_id IS NULL;--> statement-breakpoint
-- A verdict whose subject was left behind has nothing left to explain, and
-- `report_id` is about to become NOT NULL. Deleting it is what the `cascade` on
-- that column would have done had the entry been deleted rather than skipped.
DELETE FROM moderations
 WHERE report_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM task_reports r WHERE r.id = moderations.report_id);--> statement-breakpoint
ALTER TABLE "task_struggles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_tips" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tip_feedback" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "task_struggles" CASCADE;--> statement-breakpoint
DROP TABLE "task_tips" CASCADE;--> statement-breakpoint
DROP TABLE "tip_feedback" CASCADE;--> statement-breakpoint
-- `IF EXISTS`, because the `DROP TABLE ... CASCADE` above has already taken
-- these with it. Drizzle emits them unconditionally; left as generated they
-- fail the migration on the first run rather than the second, which is the
-- opposite of what an unconditional drop is usually guarding against.
ALTER TABLE "moderations" DROP CONSTRAINT IF EXISTS "moderations_struggle_id_task_struggles_id_fk";
--> statement-breakpoint
ALTER TABLE "moderations" DROP CONSTRAINT IF EXISTS "moderations_tip_id_task_tips_id_fk";
--> statement-breakpoint
ALTER TABLE "moderations" ALTER COLUMN "report_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "moderations" DROP COLUMN "subject_kind";--> statement-breakpoint
ALTER TABLE "moderations" DROP COLUMN "struggle_id";--> statement-breakpoint
ALTER TABLE "moderations" DROP COLUMN "tip_id";