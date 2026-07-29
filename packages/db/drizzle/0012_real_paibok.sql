CREATE TABLE "key_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"algorithm" text,
	"public_key" text,
	"signature" text,
	"verified_at" timestamp with time zone,
	CONSTRAINT "key_challenges_expiry_after_creation" CHECK ("key_challenges"."expires_at" > "key_challenges"."created_at"),
	CONSTRAINT "key_challenges_algorithm_known" CHECK ("key_challenges"."algorithm" is null or "key_challenges"."algorithm" in ('ed25519', 'secp256k1')),
	CONSTRAINT "key_challenges_public_key_length" CHECK ("key_challenges"."public_key" is null or char_length("key_challenges"."public_key") <= 1024),
	CONSTRAINT "key_challenges_signature_length" CHECK ("key_challenges"."signature" is null or char_length("key_challenges"."signature") <= 512),
	CONSTRAINT "key_challenges_answer_complete" CHECK (("key_challenges"."algorithm" is null and "key_challenges"."public_key" is null and "key_challenges"."signature" is null)
          or ("key_challenges"."algorithm" is not null and "key_challenges"."public_key" is not null and "key_challenges"."signature" is not null)),
	CONSTRAINT "key_challenges_verified_with_answer" CHECK ("key_challenges"."verified_at" is null
          or ("key_challenges"."signature" is not null and "key_challenges"."verified_at" <= "key_challenges"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "key_challenges" ADD CONSTRAINT "key_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "key_challenges_nonce_unique" ON "key_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "key_challenges_public_key_unique" ON "key_challenges" USING btree ("public_key") WHERE "key_challenges"."verified_at" is not null;--> statement-breakpoint
CREATE INDEX "key_challenges_agent_verified_idx" ON "key_challenges" USING btree ("agent_id","verified_at");