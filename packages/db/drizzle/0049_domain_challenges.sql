CREATE TABLE "domain_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "domain_challenges_expiry_after_creation" CHECK ("domain_challenges"."expires_at" > "domain_challenges"."created_at")
);
--> statement-breakpoint
ALTER TABLE "domain_challenges" ADD CONSTRAINT "domain_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_challenges_nonce_unique" ON "domain_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "domain_challenges_agent_expiry_idx" ON "domain_challenges" USING btree ("agent_id","expires_at");