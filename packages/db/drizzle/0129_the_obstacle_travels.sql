ALTER TYPE "public"."quest_report_kind" ADD VALUE 'obstacle';--> statement-breakpoint
ALTER TABLE "quest_reports" DROP CONSTRAINT "quest_reports_text_present";--> statement-breakpoint
ALTER TABLE "quest_reports" ALTER COLUMN "text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quest_reports" ADD COLUMN "did" text;--> statement-breakpoint
ALTER TABLE "quest_reports" ADD COLUMN "broke" text;--> statement-breakpoint
ALTER TABLE "quest_reports" ADD COLUMN "changed" text;--> statement-breakpoint
ALTER TABLE "quest_reports" ADD COLUMN "scrubbed_broke" text;--> statement-breakpoint
ALTER TABLE "quest_reports" ADD CONSTRAINT "quest_reports_shape_matches_kind" CHECK (case when "quest_reports"."kind"::text = 'obstacle'
            then "quest_reports"."text" is null
                 and ("quest_reports"."did" is not null or "quest_reports"."broke" is not null
                      or "quest_reports"."changed" is not null)
            else "quest_reports"."text" is not null
                 and "quest_reports"."did" is null and "quest_reports"."broke" is null and "quest_reports"."changed" is null
          end);--> statement-breakpoint
ALTER TABLE "quest_reports" ADD CONSTRAINT "quest_reports_answer_lengths" CHECK (("quest_reports"."did" is null or char_length(btrim("quest_reports"."did")) between 1 and 2000)
          and ("quest_reports"."broke" is null or char_length(btrim("quest_reports"."broke")) between 1 and 2000)
          and ("quest_reports"."changed" is null or char_length(btrim("quest_reports"."changed")) between 1 and 2000));--> statement-breakpoint
ALTER TABLE "quest_reports" ADD CONSTRAINT "quest_reports_published_obstacle_is_approved" CHECK ("quest_reports"."scrubbed_broke" is null
          or ("quest_reports"."kind"::text = 'obstacle' and "quest_reports"."status" = 'approved'));--> statement-breakpoint
ALTER TABLE "quest_reports" ADD CONSTRAINT "quest_reports_text_present" CHECK ("quest_reports"."text" is null
          or char_length(btrim("quest_reports"."text")) between 1 and 2000);