CREATE TYPE "public"."autonomy_default_rule" AS ENUM('ask', 'refrain');--> statement-breakpoint
CREATE TYPE "public"."autonomy_level" AS ENUM('accompanied', 'independent', 'free');--> statement-breakpoint
CREATE TABLE "autonomy_contracts" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"level" "autonomy_level" NOT NULL,
	"challenges_allowed" boolean NOT NULL,
	"default_rule" "autonomy_default_rule" NOT NULL,
	"operator_route" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_due_at" timestamp with time zone NOT NULL,
	CONSTRAINT "autonomy_contracts_route_present" CHECK (char_length(btrim("autonomy_contracts"."operator_route")) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "autonomy_form_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"operator_address" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "autonomy_contracts" ADD CONSTRAINT "autonomy_contracts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_form_invitations" ADD CONSTRAINT "autonomy_form_invitations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autonomy_form_invitations_token_idx" ON "autonomy_form_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "autonomy_form_invitations_agent_idx" ON "autonomy_form_invitations" USING btree ("agent_id","expires_at");