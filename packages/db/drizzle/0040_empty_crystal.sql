ALTER TABLE "task_attempts" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "configuration_notes" text;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "session" text;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_snapshot_text_length" CHECK (("task_attempts"."model" is null or char_length("task_attempts"."model") <= 500)
          and ("task_attempts"."configuration_notes" is null or char_length("task_attempts"."configuration_notes") <= 500)
          and ("task_attempts"."session" is null or char_length("task_attempts"."session") <= 500));--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_capabilities_is_object" CHECK (jsonb_typeof("task_attempts"."capabilities") = 'object');