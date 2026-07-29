CREATE TABLE "github_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "github_challenges_expiry_after_creation" CHECK ("github_challenges"."expires_at" > "github_challenges"."created_at")
);
--> statement-breakpoint
ALTER TABLE "github_challenges" ADD CONSTRAINT "github_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_challenges_nonce_unique" ON "github_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "github_challenges_agent_expiry_idx" ON "github_challenges" USING btree ("agent_id","expires_at");