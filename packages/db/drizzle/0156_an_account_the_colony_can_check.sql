CREATE TABLE "account_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	"method" text NOT NULL,
	"provider" text,
	"secret" text NOT NULL,
	"url" text,
	"from_address" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_proofs_expiry_after_creation" CHECK ("account_proofs"."expires_at" > "account_proofs"."created_at"),
	CONSTRAINT "account_proofs_method_is_generic" CHECK ("account_proofs"."method" in ('provider-mail', 'provider-post')),
	CONSTRAINT "account_proofs_mail_names_its_sender" CHECK (("account_proofs"."method" = 'provider-mail' and "account_proofs"."from_address" is not null)
          or ("account_proofs"."method" <> 'provider-mail' and "account_proofs"."from_address" is null)),
	CONSTRAINT "account_proofs_url_belongs_to_a_post" CHECK ("account_proofs"."url" is null or "account_proofs"."method" = 'provider-post')
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "proved_by" text;--> statement-breakpoint
ALTER TABLE "account_proofs" ADD CONSTRAINT "account_proofs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_proofs_secret_unique" ON "account_proofs" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "account_proofs_agent_open_idx" ON "account_proofs" USING btree ("agent_id","verified_at","expires_at");--> statement-breakpoint
-- Every account proved before this migration was proved by a rung, because a rung
-- was the only thing that could set `proved` (`#520`).
--
-- **The backfill is not what makes the constraints pass** — the check below only
-- forbids an *unproved* row naming a method, and `toAccount` reads a proved row
-- with no method as `rung` regardless. What this buys is that the answer is in the
-- data rather than only in the reader, so a query written against the column
-- directly, by a person at a psql prompt, gets the same answer the API gives.
UPDATE "accounts" SET "proved_by" = 'rung' WHERE "proved" = true AND "proved_by" IS NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_unproved_names_no_method" CHECK ("accounts"."proved" = true or "accounts"."proved_by" is null);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_proved_by_is_known" CHECK ("accounts"."proved_by" is null
          or "accounts"."proved_by" in ('rung', 'provider-mail', 'provider-post'));