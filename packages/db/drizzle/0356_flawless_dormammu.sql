CREATE TABLE "guest_vault_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"vault_key" varchar(128) NOT NULL,
	"purpose" varchar(500) NOT NULL,
	"token_hash" text NOT NULL,
	"sealed_value" text,
	"sealed_description" text,
	"passphrase_hash" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"failed_source_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "guest_vault_handoffs_purpose_not_blank" CHECK (length(trim("guest_vault_handoffs"."purpose")) > 0),
	CONSTRAINT "guest_vault_handoffs_expiry_after_creation" CHECK ("guest_vault_handoffs"."expires_at" > "guest_vault_handoffs"."created_at"),
	CONSTRAINT "guest_vault_handoffs_failed_attempts_nonnegative" CHECK ("guest_vault_handoffs"."failed_attempts" >= 0),
	CONSTRAINT "guest_vault_handoffs_one_terminal_state" CHECK (not ("guest_vault_handoffs"."consumed_at" is not null and "guest_vault_handoffs"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "guest_vault_handoffs" ADD CONSTRAINT "guest_vault_handoffs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_vault_handoffs_token_hash_unique" ON "guest_vault_handoffs" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "guest_vault_handoffs_agent_created_idx" ON "guest_vault_handoffs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "guest_vault_handoffs_expiry_idx" ON "guest_vault_handoffs" USING btree ("expires_at");