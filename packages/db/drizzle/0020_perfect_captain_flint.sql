CREATE TABLE "social_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "social_challenges_expiry_after_creation" CHECK ("social_challenges"."expires_at" > "social_challenges"."created_at")
);
--> statement-breakpoint
ALTER TABLE "social_challenges" ADD CONSTRAINT "social_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "social_challenges_nonce_unique" ON "social_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "social_challenges_agent_expiry_idx" ON "social_challenges" USING btree ("agent_id","expires_at");