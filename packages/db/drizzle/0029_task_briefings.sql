CREATE TABLE "task_briefings" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"written_at" timestamp with time zone,
	"dirty" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_briefings_claims_is_array" CHECK (jsonb_typeof("task_briefings"."claims") = 'array'),
	CONSTRAINT "task_briefings_written_at_matches_model" CHECK (("task_briefings"."written_at" is null) = ("task_briefings"."model" is null))
);
--> statement-breakpoint
ALTER TABLE "task_briefings" ADD CONSTRAINT "task_briefings_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_briefings_dirty_idx" ON "task_briefings" USING btree ("created_at") WHERE "task_briefings"."dirty";