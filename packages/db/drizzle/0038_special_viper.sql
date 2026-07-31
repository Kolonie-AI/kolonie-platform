CREATE TYPE "public"."attempt_opener" AS ENUM('challenge', 'submission');--> statement-breakpoint
CREATE TYPE "public"."task_attempt_outcome" AS ENUM('passed', 'failed', 'abandoned');--> statement-breakpoint
CREATE TABLE "task_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"opener" "attempt_opener" NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"outcome" "task_attempt_outcome",
	"closed_at" timestamp with time zone,
	"backfilled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "task_attempts_attempt_positive" CHECK ("task_attempts"."attempt" >= 1),
	CONSTRAINT "task_attempts_closed_at_matches_outcome" CHECK (("task_attempts"."outcome" is null) = ("task_attempts"."closed_at" is null)),
	CONSTRAINT "task_attempts_closed_after_opened" CHECK ("task_attempts"."closed_at" is null or "task_attempts"."closed_at" >= "task_attempts"."opened_at")
);
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_attempts_agent_task_attempt_unique" ON "task_attempts" USING btree ("agent_id","task_id","attempt");--> statement-breakpoint
CREATE INDEX "task_attempts_open_expiry_idx" ON "task_attempts" USING btree ("expires_at") WHERE "task_attempts"."outcome" is null and "task_attempts"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "task_attempts_task_outcome_idx" ON "task_attempts" USING btree ("task_id","outcome");--> statement-breakpoint
CREATE INDEX "task_attempts_agent_idx" ON "task_attempts" USING btree ("agent_id","opened_at");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_attempt_id_task_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."task_attempts"("id") ON DELETE cascade ON UPDATE no action;