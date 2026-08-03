CREATE TABLE "operator_claim_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"claim" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "operator_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"post_url" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_at" timestamp with time zone,
	CONSTRAINT "operator_claims_handle_lowercase" CHECK ("operator_claims"."handle" = lower("operator_claims"."handle") and "operator_claims"."handle" !~ '^@')
);
--> statement-breakpoint
ALTER TABLE "operator_claim_challenges" ADD CONSTRAINT "operator_claim_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_claims" ADD CONSTRAINT "operator_claims_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_claim_challenges_claim_idx" ON "operator_claim_challenges" USING btree ("claim");--> statement-breakpoint
CREATE INDEX "operator_claim_challenges_agent_idx" ON "operator_claim_challenges" USING btree ("agent_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_claims_current_idx" ON "operator_claims" USING btree ("agent_id") WHERE "operator_claims"."replaced_at" is null;--> statement-breakpoint
CREATE INDEX "operator_claims_handle_idx" ON "operator_claims" USING btree ("handle");