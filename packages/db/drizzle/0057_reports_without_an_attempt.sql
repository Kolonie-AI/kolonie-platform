ALTER TABLE "task_reports" ALTER COLUMN "attempt_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_reports" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "task_reports" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_reports_one_unattempted_per_agent_task" ON "task_reports" USING btree ("agent_id","task_id") WHERE "task_reports"."attempt_id" is null;--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_owner_is_one_or_the_other" CHECK (("task_reports"."attempt_id" is not null and "task_reports"."agent_id" is null and "task_reports"."task_id" is null)
          or ("task_reports"."attempt_id" is null and "task_reports"."agent_id" is not null and "task_reports"."task_id" is not null));