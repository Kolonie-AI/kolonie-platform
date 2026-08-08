CREATE TYPE "public"."payout_obligation_kind" AS ENUM('report', 'review');--> statement-breakpoint
DROP INDEX "payout_obligations_submission_unique";--> statement-breakpoint
ALTER TABLE "payout_obligations" ALTER COLUMN "submission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_obligations" ADD COLUMN "kind" "payout_obligation_kind" DEFAULT 'report' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_obligations_review_unique" ON "payout_obligations" USING btree ("task_id","agent_id") WHERE "payout_obligations"."kind" = 'review';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_obligations_submission_unique" ON "payout_obligations" USING btree ("submission_id") WHERE "payout_obligations"."submission_id" is not null;--> statement-breakpoint
ALTER TABLE "payout_obligations" ADD CONSTRAINT "payout_obligations_submission_iff_report" CHECK (("payout_obligations"."kind" = 'report') = ("payout_obligations"."submission_id" is not null));