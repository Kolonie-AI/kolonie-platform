CREATE TABLE "agent_wakeup_state" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"repeats" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_wakeup_state" ADD CONSTRAINT "agent_wakeup_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;