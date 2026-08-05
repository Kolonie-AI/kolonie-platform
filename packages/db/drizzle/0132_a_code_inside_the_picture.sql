CREATE TABLE "artefact_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"code" text NOT NULL,
	"artefact_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"served_at" timestamp with time zone,
	CONSTRAINT "artefact_challenges_expiry_after_creation" CHECK ("artefact_challenges"."expires_at" > "artefact_challenges"."created_at"),
	CONSTRAINT "artefact_challenges_served_has_a_url" CHECK ("artefact_challenges"."served_at" is null or "artefact_challenges"."artefact_url" is not null)
);
--> statement-breakpoint
ALTER TABLE "artefact_challenges" ADD CONSTRAINT "artefact_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artefact_challenges_agent_idx" ON "artefact_challenges" USING btree ("agent_id","created_at" DESC NULLS LAST);