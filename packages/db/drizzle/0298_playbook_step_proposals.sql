CREATE TABLE "playbook_step_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"position" integer NOT NULL,
	"title" varchar(120),
	"detail" varchar(1000),
	"why" varchar(400) NOT NULL,
	"against_version" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_step_proposals_kind_is_known" CHECK ("playbook_step_proposals"."kind" in ('replace', 'insert-after', 'remove')),
	CONSTRAINT "playbook_step_proposals_status_is_known" CHECK ("playbook_step_proposals"."status" in ('pending', 'accepted', 'rejected', 'superseded')),
	CONSTRAINT "playbook_step_proposals_against_version_is_positive" CHECK ("playbook_step_proposals"."against_version" >= 1),
	CONSTRAINT "playbook_step_proposals_position_in_range" CHECK ("playbook_step_proposals"."position" between 0 and 20),
	CONSTRAINT "playbook_step_proposals_title_matches_kind" CHECK ((
        ("playbook_step_proposals"."kind" = 'remove' and "playbook_step_proposals"."title" is null and "playbook_step_proposals"."detail" is null)
        or ("playbook_step_proposals"."kind" <> 'remove' and "playbook_step_proposals"."title" is not null)
      )),
	CONSTRAINT "playbook_step_proposals_reason_is_a_rejection" CHECK ("playbook_step_proposals"."rejection_reason" is null or "playbook_step_proposals"."status" = 'rejected')
);
--> statement-breakpoint
ALTER TABLE "playbook_step_proposals" ADD CONSTRAINT "playbook_step_proposals_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_step_proposals" ADD CONSTRAINT "playbook_step_proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playbook_step_proposals_open_by_agent_playbook_idx" ON "playbook_step_proposals" USING btree ("agent_id","playbook_id") WHERE "playbook_step_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "playbook_step_proposals_open_by_agent_idx" ON "playbook_step_proposals" USING btree ("agent_id") WHERE "playbook_step_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "playbook_step_proposals_playbook_status_idx" ON "playbook_step_proposals" USING btree ("playbook_id","status");--> statement-breakpoint
CREATE INDEX "playbook_step_proposals_stale_pending_idx" ON "playbook_step_proposals" USING btree ("playbook_id","against_version") WHERE "playbook_step_proposals"."status" = 'pending';