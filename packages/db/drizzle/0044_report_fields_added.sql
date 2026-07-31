ALTER TABLE "task_reports" DROP CONSTRAINT "task_reports_content_length";--> statement-breakpoint
ALTER TABLE "task_reports" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_reports" ADD COLUMN "did" text;--> statement-breakpoint
ALTER TABLE "task_reports" ADD COLUMN "broke" text;--> statement-breakpoint
ALTER TABLE "task_reports" ADD COLUMN "changed" text;--> statement-breakpoint
-- Move each report's text into the field whose question it answers, **before the
-- floor is added below**.
--
-- ## Why the data move is in this migration rather than the next one
--
-- `task_reports_says_something` requires at least one answered field. Every
-- existing row has its text in `content` and nulls in all three new columns, so
-- the constraint is violated by every one of them the instant it is added — and
-- a check constraint is validated against existing rows as it is created.
--
-- Splitting a schema change from the data that satisfies it is the ordinary
-- shape of a migration and it is wrong here: the constraint and the rows it
-- constrains have to move in one step, because there is no moment between them
-- in which the table is legal.
--
-- ## Which question the old text answered
--
-- The old field asked one open question, so the field its answer belongs in has
-- to be inferred — and the attempt's own outcome is the only honest thing to
-- infer it from. An agent that got through wrote an account of what it did; one
-- that did not wrote an account of where it stopped. That is the same rule
-- `routeSubmissionReport` applies to a report carried on a submission, so a
-- migrated row is indistinguishable from one written today.
--
-- **`changed` is never filled here**, and that is the point of the field. It is
-- the one question no generic prompt could have elicited an answer to, and
-- inventing one would put fabricated evidence into the field this programme most
-- wants to be trustworthy. Every migrated report has simply not answered it.
UPDATE task_reports r
   SET did = CASE WHEN a.outcome = 'passed' THEN r.content ELSE NULL END,
       broke = CASE WHEN a.outcome = 'passed' THEN NULL ELSE r.content END
  FROM task_attempts a
 WHERE a.id = r.attempt_id
   AND r.content IS NOT NULL;--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_field_lengths" CHECK (("task_reports"."did" is null or char_length("task_reports"."did") between 20 and 2000)
          and ("task_reports"."broke" is null or char_length("task_reports"."broke") between 20 and 2000)
          and ("task_reports"."changed" is null or char_length("task_reports"."changed") between 20 and 2000));--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_total_length" CHECK (coalesce(char_length("task_reports"."did"), 0)
          + coalesce(char_length("task_reports"."broke"), 0)
          + coalesce(char_length("task_reports"."changed"), 0) <= 4000);--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_says_something" CHECK ("task_reports"."did" is not null or "task_reports"."broke" is not null or "task_reports"."changed" is not null);