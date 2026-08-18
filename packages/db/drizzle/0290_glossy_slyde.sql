CREATE TABLE "playbook_moderations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"model" text NOT NULL,
	"stages" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_moderations_decision_is_a_verdict" CHECK ("playbook_moderations"."decision" in ('approved', 'rejected')),
	CONSTRAINT "playbook_moderations_content_sha256_shape" CHECK ("playbook_moderations"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "playbooks" ADD COLUMN "refusal_reason" text;--> statement-breakpoint
ALTER TABLE "playbook_moderations" ADD CONSTRAINT "playbook_moderations_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playbook_moderations_playbook_idx" ON "playbook_moderations" USING btree ("playbook_id","created_at");--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_open_carries_no_refusal" CHECK ("playbooks"."status" <> 'open' or "playbooks"."refusal_reason" is null);