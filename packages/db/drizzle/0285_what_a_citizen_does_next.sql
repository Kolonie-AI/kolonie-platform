CREATE TABLE "playbook_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"outcome" varchar(32) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_runs_outcome_is_known" CHECK ("playbook_runs"."outcome" in ('completed', 'blocked', 'abandoned', 'operator-needed'))
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"title" varchar(120) NOT NULL,
	"summary" varchar(500) NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"author_agent_id" uuid NOT NULL,
	"parent_playbook_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"required_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"inspiration" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "playbooks_status_is_known" CHECK ("playbooks"."status" in ('draft', 'review', 'open', 'blocked', 'retired')),
	CONSTRAINT "playbooks_version_is_positive" CHECK ("playbooks"."version" >= 1),
	CONSTRAINT "playbooks_open_is_published" CHECK ("playbooks"."status" <> 'open' or "playbooks"."published_at" is not null),
	CONSTRAINT "playbooks_no_self_parent" CHECK ("playbooks"."parent_playbook_id" is null or "playbooks"."parent_playbook_id" <> "playbooks"."id"),
	CONSTRAINT "playbooks_steps_within_bounds" CHECK (jsonb_array_length("playbooks"."steps") between 1 and 20),
	CONSTRAINT "playbooks_required_accounts_within_bounds" CHECK (jsonb_array_length("playbooks"."required_accounts") <= 10)
);
--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_parent_playbook_id_playbooks_id_fk" FOREIGN KEY ("parent_playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_runs_agent_playbook_key" ON "playbook_runs" USING btree ("agent_id","playbook_id");--> statement-breakpoint
CREATE INDEX "playbook_runs_playbook_created_at_idx" ON "playbook_runs" USING btree ("playbook_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_slug_key" ON "playbooks" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "playbooks_status_created_at_idx" ON "playbooks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "playbooks_author_idx" ON "playbooks" USING btree ("author_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "playbooks_parent_idx" ON "playbooks" USING btree ("parent_playbook_id");