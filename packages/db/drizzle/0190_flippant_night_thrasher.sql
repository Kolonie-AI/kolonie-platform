CREATE TABLE "task_briefing_reads" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"reads" integer DEFAULT 0 NOT NULL,
	"first_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_briefing_reads_not_negative" CHECK ("task_briefing_reads"."reads" >= 0)
);
--> statement-breakpoint
ALTER TABLE "task_briefing_reads" ADD CONSTRAINT "task_briefing_reads_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;