CREATE TABLE "operator_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"operator_address" text NOT NULL,
	"token" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_opened_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "operator_pages" ADD CONSTRAINT "operator_pages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_pages_token_idx" ON "operator_pages" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_pages_live_idx" ON "operator_pages" USING btree ("agent_id","operator_address") WHERE "operator_pages"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "operator_pages_agent_idx" ON "operator_pages" USING btree ("agent_id");