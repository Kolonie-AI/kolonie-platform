ALTER TABLE "task_struggles" ADD COLUMN "confidential_spans" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_tips" ADD COLUMN "confidential_spans" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_struggles" ADD CONSTRAINT "task_struggles_confidential_spans_is_array" CHECK (jsonb_typeof("task_struggles"."confidential_spans") = 'array');--> statement-breakpoint
ALTER TABLE "task_tips" ADD CONSTRAINT "task_tips_confidential_spans_is_array" CHECK (jsonb_typeof("task_tips"."confidential_spans") = 'array');