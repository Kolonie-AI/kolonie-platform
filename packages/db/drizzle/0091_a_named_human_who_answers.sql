CREATE TABLE "operator_addresses" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"recheck_due_at" timestamp with time zone,
	CONSTRAINT "operator_addresses_present" CHECK (char_length(btrim("operator_addresses"."address")) > 0)
);
--> statement-breakpoint
ALTER TABLE "operator_addresses" ADD CONSTRAINT "operator_addresses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_addresses_address_idx" ON "operator_addresses" USING btree ("address");