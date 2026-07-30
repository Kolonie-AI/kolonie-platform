CREATE TABLE "website_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "website_challenges_expiry_after_creation" CHECK ("website_challenges"."expires_at" > "website_challenges"."created_at")
);
--> statement-breakpoint
ALTER TABLE "website_challenges" ADD CONSTRAINT "website_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "website_challenges_token_unique" ON "website_challenges" USING btree ("token");--> statement-breakpoint
CREATE INDEX "website_challenges_agent_expiry_idx" ON "website_challenges" USING btree ("agent_id","expires_at");