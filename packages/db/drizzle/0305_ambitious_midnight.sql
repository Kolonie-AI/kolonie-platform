CREATE TABLE "playbook_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"from_status" varchar(16) NOT NULL,
	"to_status" varchar(16) NOT NULL,
	"reason" text NOT NULL,
	"decided_by" varchar(32) NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_status_events_from_is_known" CHECK ("playbook_status_events"."from_status" in ('draft', 'review', 'open', 'blocked', 'retired')),
	CONSTRAINT "playbook_status_events_to_is_known" CHECK ("playbook_status_events"."to_status" in ('draft', 'review', 'open', 'blocked', 'retired')),
	CONSTRAINT "playbook_status_events_decided_by_is_known" CHECK ("playbook_status_events"."decided_by" in ('moderation')),
	CONSTRAINT "playbook_status_events_is_open_blocked_pair" CHECK (("playbook_status_events"."from_status" = 'open' and "playbook_status_events"."to_status" = 'blocked')
        or ("playbook_status_events"."from_status" = 'blocked' and "playbook_status_events"."to_status" = 'open')),
	CONSTRAINT "playbook_status_events_reason_not_blank" CHECK (length(trim("playbook_status_events"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "playbooks" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "playbooks" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "playbooks" ADD COLUMN "status_changed_by" varchar(32);--> statement-breakpoint
ALTER TABLE "playbook_status_events" ADD CONSTRAINT "playbook_status_events_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playbook_status_events_playbook_idx" ON "playbook_status_events" USING btree ("playbook_id","decided_at");--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_status_transition_is_complete" CHECK (("playbooks"."status_reason" is null and "playbooks"."status_changed_at" is null and "playbooks"."status_changed_by" is null)
        or ("playbooks"."status_reason" is not null and "playbooks"."status_changed_at" is not null
          and "playbooks"."status_changed_by" in ('moderation')));