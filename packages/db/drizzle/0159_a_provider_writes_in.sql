CREATE TABLE "provider_enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product" text NOT NULL,
	"url" text NOT NULL,
	"contact" text NOT NULL,
	"wants" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	CONSTRAINT "provider_enquiries_product_length" CHECK (char_length(btrim("provider_enquiries"."product")) between 1 and 2000),
	CONSTRAINT "provider_enquiries_url_length" CHECK (char_length(btrim("provider_enquiries"."url")) between 1 and 500),
	CONSTRAINT "provider_enquiries_contact_length" CHECK (char_length(btrim("provider_enquiries"."contact")) between 1 and 300),
	CONSTRAINT "provider_enquiries_wants_length" CHECK (char_length(btrim("provider_enquiries"."wants")) between 1 and 2000)
);
--> statement-breakpoint
CREATE INDEX "provider_enquiries_waiting_idx" ON "provider_enquiries" USING btree ("handled_at","created_at");