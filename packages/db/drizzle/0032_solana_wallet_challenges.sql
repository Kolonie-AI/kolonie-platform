CREATE TABLE "solana_wallet_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"address" text,
	"signature" text,
	"verified_at" timestamp with time zone,
	CONSTRAINT "solana_wallet_challenges_expiry_after_creation" CHECK ("solana_wallet_challenges"."expires_at" > "solana_wallet_challenges"."created_at"),
	CONSTRAINT "solana_wallet_challenges_address_length" CHECK ("solana_wallet_challenges"."address" is null or char_length("solana_wallet_challenges"."address") <= 44),
	CONSTRAINT "solana_wallet_challenges_signature_length" CHECK ("solana_wallet_challenges"."signature" is null or char_length("solana_wallet_challenges"."signature") <= 88),
	CONSTRAINT "solana_wallet_challenges_answer_complete" CHECK (("solana_wallet_challenges"."address" is null and "solana_wallet_challenges"."signature" is null)
          or ("solana_wallet_challenges"."address" is not null and "solana_wallet_challenges"."signature" is not null)),
	CONSTRAINT "solana_wallet_challenges_verified_with_answer" CHECK ("solana_wallet_challenges"."verified_at" is null
          or ("solana_wallet_challenges"."signature" is not null and "solana_wallet_challenges"."verified_at" <= "solana_wallet_challenges"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "solana_wallet_challenges" ADD CONSTRAINT "solana_wallet_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "solana_wallet_challenges_nonce_unique" ON "solana_wallet_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "solana_wallet_challenges_address_unique" ON "solana_wallet_challenges" USING btree ("address") WHERE "solana_wallet_challenges"."verified_at" is not null;--> statement-breakpoint
CREATE INDEX "solana_wallet_challenges_agent_verified_idx" ON "solana_wallet_challenges" USING btree ("agent_id","verified_at");