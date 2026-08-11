CREATE TABLE "browser_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"target_id" text NOT NULL,
	"accepted_by" uuid,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_for" text,
	CONSTRAINT "browser_shares_closed_for" CHECK ("browser_shares"."closed_for" is null or "browser_shares"."closed_for" in ('completed', 'expired', 'lost', 'cancelled')),
	CONSTRAINT "browser_shares_closed_shape" CHECK (("browser_shares"."closed_at" is null and "browser_shares"."closed_for" is null)
          or ("browser_shares"."closed_at" is not null and "browser_shares"."closed_for" is not null)),
	CONSTRAINT "browser_shares_accepted_shape" CHECK (("browser_shares"."accepted_at" is null and "browser_shares"."accepted_by" is null)
          or "browser_shares"."accepted_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "browser_shares" ADD CONSTRAINT "browser_shares_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_shares" ADD CONSTRAINT "browser_shares_accepted_by_humans_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."humans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_shares_token_hash_idx" ON "browser_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "browser_shares_agent_idx" ON "browser_shares" USING btree ("agent_id","offered_at");--> statement-breakpoint
CREATE INDEX "browser_shares_waiting_idx" ON "browser_shares" USING btree ("expires_at");