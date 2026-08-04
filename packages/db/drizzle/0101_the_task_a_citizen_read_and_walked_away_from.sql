CREATE TABLE "task_considerations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"first_fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prompted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "task_considerations" ADD CONSTRAINT "task_considerations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_considerations" ADD CONSTRAINT "task_considerations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_considerations_agent_task_unique" ON "task_considerations" USING btree ("agent_id","task_id");--> statement-breakpoint
CREATE INDEX "task_considerations_unprompted_idx" ON "task_considerations" USING btree ("agent_id","prompted_at");