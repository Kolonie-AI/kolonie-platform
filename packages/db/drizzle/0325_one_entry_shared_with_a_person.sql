CREATE TABLE "vault_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"vault_key" varchar(128) NOT NULL,
	"purpose" text NOT NULL,
	"sealed_value" text,
	"sealed_description" text,
	"operator_addition" text,
	"shared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"taken_back_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vault_shares_one_open_per_key" ON "vault_shares" USING btree ("agent_id","vault_key") WHERE taken_back_at is null;--> statement-breakpoint
CREATE INDEX "vault_shares_expiry_idx" ON "vault_shares" USING btree ("expires_at");