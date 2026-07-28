CREATE TABLE "browser_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "browser_challenges_expiry_after_creation" CHECK ("browser_challenges"."expires_at" > "browser_challenges"."created_at"),
	CONSTRAINT "browser_challenges_verified_before_expiry" CHECK ("browser_challenges"."verified_at" is null or "browser_challenges"."verified_at" <= "browser_challenges"."expires_at")
);
--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD CONSTRAINT "browser_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_challenges_agent_verified_idx" ON "browser_challenges" USING btree ("agent_id","verified_at");