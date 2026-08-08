CREATE TABLE "account_wishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"author" "operator_request_author" NOT NULL,
	"noticed_while" text,
	"wanted_at" timestamp with time zone,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_wishes_provider_length" CHECK (length("account_wishes"."provider") between 1 and 128),
	CONSTRAINT "account_wishes_note_length" CHECK ("account_wishes"."noticed_while" is null or length("account_wishes"."noticed_while") between 1 and 600),
	CONSTRAINT "account_wishes_only_a_citizen_noticed" CHECK ("account_wishes"."author" = 'citizen' or "account_wishes"."noticed_while" is null)
);
--> statement-breakpoint
ALTER TABLE "account_wishes" ADD CONSTRAINT "account_wishes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_wishes_agent_provider_unique" ON "account_wishes" USING btree ("agent_id","provider");--> statement-breakpoint
CREATE INDEX "account_wishes_agent_idx" ON "account_wishes" USING btree ("agent_id","added_at");