-- Retire the column the three fields replaced.
--
-- `0044` added them and moved the text; this only drops what is left. The two
-- ship in the same deploy, so no release has both shapes live.
ALTER TABLE "task_reports" DROP COLUMN "content";
