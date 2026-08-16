CREATE TABLE "agent_walk_suggestions" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_walk_suggestions" ADD CONSTRAINT "agent_walk_suggestions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;