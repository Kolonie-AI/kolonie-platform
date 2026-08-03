CREATE TABLE "deposit_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"address" varchar(64) NOT NULL,
	"secret_sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signature" varchar(120) NOT NULL,
	"agent_id" uuid,
	"address" varchar(64) NOT NULL,
	"base_units" bigint NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"remainder" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credited_at" timestamp with time zone,
	"rejection" text,
	CONSTRAINT "deposits_credited_xor_rejected" CHECK (("deposits"."credited_at" is null) <> ("deposits"."rejection" is null)),
	CONSTRAINT "deposits_credited_amounts" CHECK (("deposits"."credited_at" is not null) or ("deposits"."credits" = 0)),
	CONSTRAINT "deposits_amounts_non_negative" CHECK ("deposits"."base_units" >= 0 and "deposits"."credits" >= 0 and "deposits"."remainder" >= 0)
);
--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_addresses_agent_unique" ON "deposit_addresses" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_addresses_address_unique" ON "deposit_addresses" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_signature_unique" ON "deposits" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "deposits_agent_idx" ON "deposits" USING btree ("agent_id","observed_at");