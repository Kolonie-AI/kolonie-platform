CREATE TABLE "playbook_briefing_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"section" text NOT NULL,
	"text" text NOT NULL,
	"sources" uuid[] NOT NULL,
	"reports" integer NOT NULL,
	"platforms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_supported_at" timestamp with time zone NOT NULL,
	"step_position" integer,
	"revision" integer NOT NULL,
	CONSTRAINT "playbook_briefing_claims_section_is_known" CHECK ("playbook_briefing_claims"."section" in ('step', 'route', 'yield', 'unsolved')),
	CONSTRAINT "playbook_briefing_claims_text_not_blank" CHECK (length(trim("playbook_briefing_claims"."text")) > 0),
	CONSTRAINT "playbook_briefing_claims_reports_positive" CHECK ("playbook_briefing_claims"."reports" >= 1),
	CONSTRAINT "playbook_briefing_claims_sources_not_empty" CHECK (cardinality("playbook_briefing_claims"."sources") >= 1),
	CONSTRAINT "playbook_briefing_claims_step_position_positive" CHECK ("playbook_briefing_claims"."step_position" is null or "playbook_briefing_claims"."step_position" >= 1),
	CONSTRAINT "playbook_briefing_claims_revision_positive" CHECK ("playbook_briefing_claims"."revision" >= 1),
	CONSTRAINT "playbook_briefing_claims_platforms_is_object" CHECK (jsonb_typeof("playbook_briefing_claims"."platforms") = 'object')
);
--> statement-breakpoint
ALTER TABLE "playbook_briefing_claims" ADD CONSTRAINT "playbook_briefing_claims_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playbook_briefing_claims_playbook_idx" ON "playbook_briefing_claims" USING btree ("playbook_id");