CREATE TABLE "credential_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"stranded_vault_entries" integer NOT NULL,
	"recovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_recoveries_stranded_non_negative" CHECK ("credential_recoveries"."stranded_vault_entries" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recovery_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "recovery_challenges_expiry_after_creation" CHECK ("recovery_challenges"."expires_at" > "recovery_challenges"."created_at")
);
--> statement-breakpoint
CREATE TABLE "recovery_nominations" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"nominated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recovery_nominations_effective_after_nomination" CHECK ("recovery_nominations"."effective_at" > "recovery_nominations"."nominated_at")
);
--> statement-breakpoint
ALTER TABLE "credential_recoveries" ADD CONSTRAINT "credential_recoveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_recoveries" ADD CONSTRAINT "credential_recoveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_recoveries" ADD CONSTRAINT "credential_recoveries_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_challenges" ADD CONSTRAINT "recovery_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_challenges" ADD CONSTRAINT "recovery_challenges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_nominations" ADD CONSTRAINT "recovery_nominations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_nominations" ADD CONSTRAINT "recovery_nominations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_recoveries_agent_time_idx" ON "credential_recoveries" USING btree ("agent_id","recovered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_challenges_nonce_unique" ON "recovery_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "recovery_challenges_attempts_idx" ON "recovery_challenges" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "recovery_challenges_open_idx" ON "recovery_challenges" USING btree ("agent_id","expires_at") WHERE "recovery_challenges"."consumed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_nominations_account_unique" ON "recovery_nominations" USING btree ("account_id");--> statement-breakpoint
-- `key-signature` predates the account register projection added with recovery.
-- Future verdicts record the public key through `recordAccountsFromVerdict`, but
-- every proof already on record needs the same account or the citizen holding it
-- cannot nominate the factor it proved before this deploy.
--
-- Update before insert because account kinds are open vocabulary: a citizen may
-- already have declared this exact keypair, and a backfill that merely said
-- `on conflict do nothing` would leave that row unproved forever.
UPDATE "accounts" account
SET "proved" = true,
    "proved_at" = coalesce(account."proved_at", challenge."verified_at"),
    "proved_by" = 'rung',
    "capabilities" = ARRAY(
      SELECT DISTINCT capability
      FROM unnest(account."capabilities" || ARRAY['sign']) capability
    ),
    "updated_at" = now()
FROM "key_challenges" challenge
WHERE challenge."verified_at" IS NOT NULL
  AND challenge."public_key" IS NOT NULL
  AND account."agent_id" = challenge."agent_id"
  AND account."kind" = 'keypair'
  AND lower(account."identifier") = lower(challenge."public_key");--> statement-breakpoint
INSERT INTO "accounts" (
  "agent_id", "kind", "identifier", "proved", "proved_at", "proved_by", "capabilities"
)
SELECT
  challenge."agent_id", 'keypair', challenge."public_key", true,
  challenge."verified_at", 'rung', ARRAY['sign']
FROM "key_challenges" challenge
WHERE challenge."verified_at" IS NOT NULL
  AND challenge."public_key" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "accounts" account
    WHERE account."agent_id" = challenge."agent_id"
      AND account."kind" = 'keypair'
      AND lower(account."identifier") = lower(challenge."public_key")
  )
ON CONFLICT DO NOTHING;