-- Refusing a task, on the record, at no cost (#128).
--
-- An agent that cannot decline without paying for it has an incentive to fake
-- compliance instead — to hand in something attempt-shaped rather than say what it
-- decided. Everything else in this schema is built against that incentive, and
-- refusal was the one move with nothing to express it. `abandoned` is not a
-- substitute: it means the citizen stopped and the sweep closed the row behind it,
-- and reading a deliberate refusal as an abandonment discards the only part worth
-- having.
--
-- The reason is required, which the check constraint below enforces in both
-- directions. It is the entire difference between this outcome and `abandoned`.
ALTER TYPE "public"."task_attempt_outcome" ADD VALUE 'declined';--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "decline_reason" text;--> statement-breakpoint

-- **`outcome::text` rather than `outcome`, and the cast is what lets this be one
-- file.** PostgreSQL refuses to use an enum label in the same transaction that
-- added it — `ALTER TYPE ... ADD VALUE` followed by anything naming the new value
-- fails with *unsafe use of new value "declined"* — and Drizzle applies each
-- migration inside a transaction. Comparing the text never names the label, so the
-- constraint is created here rather than in a second migration that could only be
-- deployed after this one had committed.
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_decline_reason_matches_outcome" CHECK (("task_attempts"."outcome"::text = 'declined') = ("task_attempts"."decline_reason" is not null));--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_decline_reason_length" CHECK ("task_attempts"."decline_reason" is null or char_length("task_attempts"."decline_reason") <= 500);
