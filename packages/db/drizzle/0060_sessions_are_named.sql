CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"external_id" varchar(128) NOT NULL,
	"named_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"tokens" integer
);
--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_agent_external_unique" ON "agent_sessions" USING btree ("agent_id","external_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_current_idx" ON "agent_sessions" USING btree ("agent_id","named_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;