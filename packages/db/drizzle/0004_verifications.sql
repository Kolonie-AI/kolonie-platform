CREATE TYPE "public"."verification_status" AS ENUM('pass', 'fail', 'pending', 'timeout');--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"task_type" varchar(64) NOT NULL,
	"status" "verification_status" NOT NULL,
	"evidence" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verifications_task_type_slug" CHECK ("verifications"."task_type" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "verifications_task_type_min_length" CHECK (char_length("verifications"."task_type") >= 3),
	CONSTRAINT "verifications_evidence_length" CHECK (char_length("verifications"."evidence") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verifications_submission_id_idx" ON "verifications" USING btree ("submission_id","created_at");