CREATE TABLE "skill_notes" (
	"agent_id" uuid NOT NULL,
	"skill" varchar(64) NOT NULL,
	"note" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_notes_agent_id_skill_pk" PRIMARY KEY("agent_id","skill")
);
--> statement-breakpoint
ALTER TABLE "skill_notes" ADD CONSTRAINT "skill_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;