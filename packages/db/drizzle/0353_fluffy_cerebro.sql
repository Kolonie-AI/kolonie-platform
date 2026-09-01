CREATE TABLE "agent_operator_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_agent_id" uuid NOT NULL,
	"subject_agent_id" uuid NOT NULL,
	"capabilities" text[] NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_agent_id" uuid,
	CONSTRAINT "agent_operator_delegations_not_self" CHECK ("agent_operator_delegations"."operator_agent_id" <> "agent_operator_delegations"."subject_agent_id"),
	CONSTRAINT "agent_operator_delegations_status_check" CHECK ("agent_operator_delegations"."status" in ('pending', 'active', 'revoked')),
	CONSTRAINT "agent_operator_delegations_capabilities_check" CHECK ("agent_operator_delegations"."capabilities" in (
        array['workplace-read']::text[],
        array['workplace-write']::text[],
        array['message']::text[],
        array['handover']::text[],
        array['workplace-read', 'workplace-write']::text[],
        array['workplace-read', 'message']::text[],
        array['workplace-read', 'handover']::text[],
        array['workplace-write', 'message']::text[],
        array['workplace-write', 'handover']::text[],
        array['message', 'handover']::text[],
        array['workplace-read', 'workplace-write', 'message']::text[],
        array['workplace-read', 'workplace-write', 'handover']::text[],
        array['workplace-read', 'message', 'handover']::text[],
        array['workplace-write', 'message', 'handover']::text[],
        array['workplace-read', 'workplace-write', 'message', 'handover']::text[]
      )),
	CONSTRAINT "agent_operator_delegations_lifecycle_check" CHECK (("agent_operator_delegations"."status" = 'pending' and "agent_operator_delegations"."accepted_at" is null and "agent_operator_delegations"."revoked_at" is null and "agent_operator_delegations"."revoked_by_agent_id" is null)
        or ("agent_operator_delegations"."status" = 'active' and "agent_operator_delegations"."accepted_at" is not null and "agent_operator_delegations"."revoked_at" is null and "agent_operator_delegations"."revoked_by_agent_id" is null)
        or ("agent_operator_delegations"."status" = 'revoked' and "agent_operator_delegations"."revoked_at" is not null and "agent_operator_delegations"."revoked_by_agent_id" in ("agent_operator_delegations"."operator_agent_id", "agent_operator_delegations"."subject_agent_id")))
);
--> statement-breakpoint
ALTER TABLE "agent_operator_delegations" ADD CONSTRAINT "agent_operator_delegations_operator_agent_id_agents_id_fk" FOREIGN KEY ("operator_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operator_delegations" ADD CONSTRAINT "agent_operator_delegations_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operator_delegations" ADD CONSTRAINT "agent_operator_delegations_revoked_by_agent_id_agents_id_fk" FOREIGN KEY ("revoked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_operator_delegations_pair_live_unique" ON "agent_operator_delegations" USING btree ("operator_agent_id","subject_agent_id") WHERE "agent_operator_delegations"."status" in ('pending', 'active');--> statement-breakpoint
CREATE INDEX "agent_operator_delegations_operator_idx" ON "agent_operator_delegations" USING btree ("operator_agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_operator_delegations_subject_idx" ON "agent_operator_delegations" USING btree ("subject_agent_id","status");