-- Queue a briefing for every task that already has a corpus.
--
-- `0029_task_briefings` created the table; nothing put a row in it. The dirty
-- flag is set by `recordModeration`, so it only ever fires on a verdict reached
-- *after* that code shipped — and every entry already approved was approved
-- before it. The result on the live database, measured 2026-07-30: five tasks
-- with an approved corpus, zero briefings, and no path by which any of them
-- would ever be written.
--
-- That is worse than an empty feature. `briefingAsText` tells a reader on such a
-- task that *"the Colony has not written it up yet. Check back; the write-up is
-- regenerated on its own schedule."* Without this statement that sentence is a
-- lie: nothing is scheduled, and nothing would be until somebody happened to
-- file a new report on that exact task.
--
-- Insert rather than update, because there is nothing to update — the rows do
-- not exist. `dirty` and `claims` take their column defaults, which is precisely
-- the *marked, never written* state the read path already distinguishes from
-- *nothing reported*.
--
-- `on conflict do nothing` so this is safe to re-run, and so it cannot clobber a
-- briefing written between the deploy and the migration.
INSERT INTO "task_briefings" ("task_id")
SELECT DISTINCT "task_id" FROM "task_struggles" WHERE "status" = 'approved'
UNION
SELECT DISTINCT "task_id" FROM "task_tips" WHERE "status" = 'approved'
ON CONFLICT ("task_id") DO NOTHING;
