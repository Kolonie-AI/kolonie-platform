CREATE TABLE "account_transfer_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid NOT NULL,
	"account_kind" text NOT NULL,
	"account_identifier" text NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_transfer_receipts_names_an_account" CHECK (
      length(btrim("account_transfer_receipts"."account_kind")) > 0 and length(btrim("account_transfer_receipts"."account_identifier")) > 0)
);
--> statement-breakpoint
CREATE TABLE "account_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid NOT NULL,
	"sealed_value" text NOT NULL,
	"sealed_description" text,
	"reads" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "account_transfers_reads_bounded" CHECK ("account_transfers"."reads" >= 0 and "account_transfers"."reads" <= 1),
	CONSTRAINT "account_transfers_value_length" CHECK (char_length("account_transfers"."sealed_value") <= 32768),
	CONSTRAINT "account_transfers_description_length" CHECK ("account_transfers"."sealed_description" is null
          or char_length("account_transfers"."sealed_description")
             <= 2048),
	CONSTRAINT "account_transfers_two_citizens" CHECK ("account_transfers"."from_agent_id" <> "account_transfers"."to_agent_id")
);
--> statement-breakpoint
ALTER TABLE "account_transfer_receipts" ADD CONSTRAINT "account_transfer_receipts_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_transfer_receipts" ADD CONSTRAINT "account_transfer_receipts_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_transfer_receipts_recipient_idx" ON "account_transfer_receipts" USING btree ("to_agent_id","settled_at");--> statement-breakpoint
CREATE INDEX "account_transfer_receipts_giver_idx" ON "account_transfer_receipts" USING btree ("from_agent_id","settled_at");--> statement-breakpoint
CREATE INDEX "account_transfers_recipient_idx" ON "account_transfers" USING btree ("to_agent_id","created_at");