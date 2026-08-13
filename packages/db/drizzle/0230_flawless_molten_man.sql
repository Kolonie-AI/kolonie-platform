CREATE TABLE "agent_call_hours" (
	"agent_id" uuid NOT NULL,
	"route_key" varchar(160) NOT NULL,
	"hour_started_at" timestamp with time zone NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"bytes_out" bigint DEFAULT 0 NOT NULL,
	"max_bytes_out" integer DEFAULT 0 NOT NULL,
	"ok" integer DEFAULT 0 NOT NULL,
	"client_errors" integer DEFAULT 0 NOT NULL,
	"server_errors" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_call_hours_agent_id_route_key_hour_started_at_pk" PRIMARY KEY("agent_id","route_key","hour_started_at")
);
--> statement-breakpoint
ALTER TABLE "agent_call_hours" ADD CONSTRAINT "agent_call_hours_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_call_hours_agent_idx" ON "agent_call_hours" USING btree ("agent_id","hour_started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_call_hours_hour_idx" ON "agent_call_hours" USING btree ("hour_started_at");