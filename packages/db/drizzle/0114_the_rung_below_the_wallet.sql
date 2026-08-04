CREATE TABLE "vetting_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"sample" text NOT NULL,
	"token" text NOT NULL,
	"planted" jsonb NOT NULL,
	"manifest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vetting_challenges_expiry_after_creation" CHECK ("vetting_challenges"."expires_at" > "vetting_challenges"."created_at"),
	CONSTRAINT "vetting_challenges_something_is_planted" CHECK (jsonb_array_length("vetting_challenges"."planted") > 0)
);
--> statement-breakpoint
ALTER TABLE "vetting_challenges" ADD CONSTRAINT "vetting_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vetting_challenges_agent_expiry_idx" ON "vetting_challenges" USING btree ("agent_id","expires_at");