CREATE TABLE "task_notes" (
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"note" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_notes_agent_id_task_id_pk" PRIMARY KEY("agent_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;