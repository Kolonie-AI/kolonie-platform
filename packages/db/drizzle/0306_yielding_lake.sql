CREATE TABLE "playbook_notes" (
	"agent_id" uuid NOT NULL,
	"playbook_id" uuid NOT NULL,
	"note" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_notes_agent_id_playbook_id_pk" PRIMARY KEY("agent_id","playbook_id")
);
--> statement-breakpoint
ALTER TABLE "playbook_notes" ADD CONSTRAINT "playbook_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_notes" ADD CONSTRAINT "playbook_notes_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;