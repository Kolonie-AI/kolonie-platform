CREATE TABLE "provider_operate_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"tag" text NOT NULL,
	"body" text NOT NULL,
	"scrubbed_body" text,
	"prose_status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"episode_id" uuid,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_operate_notes_tag_is_known" CHECK ("provider_operate_notes"."tag" in ('access-method', 'api', 'quota', 'prove', 'payout-ops')),
	CONSTRAINT "provider_operate_notes_body_length" CHECK (char_length(btrim("provider_operate_notes"."body")) between 20 and 400),
	CONSTRAINT "provider_operate_notes_scrubbed_iff_approved" CHECK ("provider_operate_notes"."scrubbed_body" is null or "provider_operate_notes"."prose_status" = 'approved'),
	CONSTRAINT "provider_operate_notes_scrubbed_length" CHECK ("provider_operate_notes"."scrubbed_body" is null
          or char_length(btrim("provider_operate_notes"."scrubbed_body")) between 20 and 400)
);
--> statement-breakpoint
ALTER TABLE "provider_operate_notes" ADD CONSTRAINT "provider_operate_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_operate_notes" ADD CONSTRAINT "provider_operate_notes_episode_id_account_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."account_episodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_operate_notes_agent_pair_tag" ON "provider_operate_notes" USING btree ("agent_id","kind","provider","tag");--> statement-breakpoint
CREATE INDEX "provider_operate_notes_pair_idx" ON "provider_operate_notes" USING btree ("kind","provider");--> statement-breakpoint
CREATE INDEX "provider_operate_notes_pending_idx" ON "provider_operate_notes" USING btree ("written_at") WHERE "provider_operate_notes"."prose_status" = 'pending';