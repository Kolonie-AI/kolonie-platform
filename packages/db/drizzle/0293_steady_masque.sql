CREATE TABLE "account_offer_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"to_handle" text NOT NULL,
	"account_kind" text NOT NULL,
	"account_identifier" text NOT NULL,
	"account_provider" text,
	"outcome" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_offer_outcomes_known" CHECK ("account_offer_outcomes"."outcome" in ('accepted', 'declined', 'expired', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "account_offer_outcomes" ADD CONSTRAINT "account_offer_outcomes_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_offer_outcomes_giver_idx" ON "account_offer_outcomes" USING btree ("from_agent_id","at");