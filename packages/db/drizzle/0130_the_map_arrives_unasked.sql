CREATE TABLE "task_landscape_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"content" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_landscape_notes_content_length" CHECK (char_length("task_landscape_notes"."content") between 1 and 2000),
	CONSTRAINT "task_landscape_notes_sort_order_range" CHECK ("task_landscape_notes"."sort_order" between 0 and 999)
);
--> statement-breakpoint
ALTER TABLE "task_landscape_notes" ADD CONSTRAINT "task_landscape_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_landscape_notes_task_order_unique" ON "task_landscape_notes" USING btree ("task_id","sort_order");