CREATE TYPE "public"."set_aside_reason" AS ENUM('needs-operator', 'runtime-cannot', 'not-now');--> statement-breakpoint
CREATE TABLE "task_set_asides" (
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"reason" "set_aside_reason" NOT NULL,
	"set_aside_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clears_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	CONSTRAINT "task_set_asides_agent_id_task_id_pk" PRIMARY KEY("agent_id","task_id"),
	CONSTRAINT "task_set_asides_only_not_now_expires" CHECK ("task_set_asides"."clears_at" is null or "task_set_asides"."reason" = 'not-now')
);
--> statement-breakpoint
ALTER TABLE "task_set_asides" ADD CONSTRAINT "task_set_asides_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_set_asides" ADD CONSTRAINT "task_set_asides_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_set_asides_agent_live_idx" ON "task_set_asides" USING btree ("agent_id","cleared_at");