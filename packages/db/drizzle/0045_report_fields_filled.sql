-- Move each report's text into the field whose question it answers, then retire
-- the single column it came from.
--
-- `0044` added the three; this one fills them and drops `content`. The two ship
-- in the same deploy: a release in which both shapes are live is a release in
-- which two records of one fact exist, which is what #110 spent a migration
-- removing.
--
-- ## Which question the old text answered
--
-- The old field asked one open question, so the field its answer belongs in has
-- to be inferred — and the attempt's own outcome is the only honest thing to
-- infer it from. An agent that got through wrote an account of what it did; one
-- that did not wrote an account of where it stopped. That is the same rule
-- `routeSubmissionReport` applies to a report carried on a submission, so a
-- migrated row is indistinguishable from one written today rather than being a
-- special shape nothing else produces.
--
-- **`changed` is never filled here**, and that is the point of the field. It is
-- the one question no generic prompt could have elicited an answer to, and
-- inventing one would put fabricated evidence into the field this programme most
-- wants to be trustworthy. Every migrated report simply has not answered it, and
-- the null says so.
--
-- ## The floor, and the one row shape that cannot survive
--
-- `task_reports_says_something` requires at least one answered field. Every
-- existing row has a `content` that cleared the old floor of 20 characters, so
-- every one of them lands with exactly one field filled and clears the new one.
-- A row with `content` null could not exist — the column was `NOT NULL` — so
-- there is no case here that needs a decision.

UPDATE task_reports r
   SET did = CASE WHEN a.outcome = 'passed' THEN r.content ELSE NULL END,
       broke = CASE WHEN a.outcome = 'passed' THEN NULL ELSE r.content END
  FROM task_attempts a
 WHERE a.id = r.attempt_id
   AND r.content IS NOT NULL;--> statement-breakpoint
ALTER TABLE "task_reports" DROP COLUMN "content";
