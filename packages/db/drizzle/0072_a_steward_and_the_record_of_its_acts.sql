CREATE TYPE "public"."authority_action" AS ENUM('role-granted', 'role-revoked', 'quest-published');--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'steward' BEFORE 'judge';--> statement-breakpoint
CREATE TABLE "authority_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" "authority_action" NOT NULL,
	"subject_agent_id" uuid,
	"subject_task_id" uuid,
	"role" "role",
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authority_events" ADD CONSTRAINT "authority_events_actor_id_agents_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_events" ADD CONSTRAINT "authority_events_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_events" ADD CONSTRAINT "authority_events_subject_task_id_tasks_id_fk" FOREIGN KEY ("subject_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authority_events_actor_idx" ON "authority_events" USING btree ("actor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "authority_events_subject_idx" ON "authority_events" USING btree ("subject_agent_id","at" DESC NULLS LAST);