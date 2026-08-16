CREATE TABLE "account_offer_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"to_handle_key" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "account_offer_confirmations_expiry_after_creation" CHECK ("account_offer_confirmations"."expires_at" > "account_offer_confirmations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "account_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"to_handle" text NOT NULL,
	"to_agent_id" uuid,
	"transfer_id" uuid,
	"account_kind" text NOT NULL,
	"account_identifier" text NOT NULL,
	"account_provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_offers_two_citizens" CHECK ("account_offers"."to_agent_id" is null or "account_offers"."from_agent_id" <> "account_offers"."to_agent_id"),
	CONSTRAINT "account_offers_parcel_matches_recipient" CHECK (("account_offers"."to_agent_id" is null) = ("account_offers"."transfer_id" is null)),
	CONSTRAINT "account_offers_names_an_account" CHECK (length(btrim("account_offers"."account_kind")) > 0 and length(btrim("account_offers"."account_identifier")) > 0),
	CONSTRAINT "account_offers_expiry_after_creation" CHECK ("account_offers"."expires_at" > "account_offers"."created_at")
);
--> statement-breakpoint
ALTER TABLE "account_offer_confirmations" ADD CONSTRAINT "account_offer_confirmations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_offer_confirmations" ADD CONSTRAINT "account_offer_confirmations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_offers" ADD CONSTRAINT "account_offers_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_offers" ADD CONSTRAINT "account_offers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_offers" ADD CONSTRAINT "account_offers_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_offers" ADD CONSTRAINT "account_offers_transfer_id_account_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."account_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_offer_confirmations_token_unique" ON "account_offer_confirmations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "account_offer_confirmations_open_idx" ON "account_offer_confirmations" USING btree ("expires_at") WHERE "account_offer_confirmations"."consumed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_offers_one_per_account" ON "account_offers" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_offers_recipient_idx" ON "account_offers" USING btree ("to_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "account_offers_expiry_idx" ON "account_offers" USING btree ("expires_at");