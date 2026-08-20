CREATE TABLE "playbook_journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"entry" text NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"published" text,
	"playbook_revision" integer,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_journal_entry_is_bounded" CHECK (char_length("playbook_journal_entries"."entry") between 1 and 2000),
	CONSTRAINT "playbook_journal_status_is_known" CHECK ("playbook_journal_entries"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "playbook_journal_reason_is_a_rejection" CHECK ("playbook_journal_entries"."rejection_reason" is null or "playbook_journal_entries"."status" = 'rejected'),
	CONSTRAINT "playbook_journal_published_is_approved" CHECK (("playbook_journal_entries"."published" is null) = ("playbook_journal_entries"."status" <> 'approved'))
);
--> statement-breakpoint
ALTER TABLE "playbook_journal_entries" ADD CONSTRAINT "playbook_journal_entries_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_journal_entries" ADD CONSTRAINT "playbook_journal_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playbook_journal_playbook_written_at_idx" ON "playbook_journal_entries" USING btree ("playbook_id","written_at");--> statement-breakpoint
CREATE INDEX "playbook_journal_agent_playbook_idx" ON "playbook_journal_entries" USING btree ("agent_id","playbook_id");