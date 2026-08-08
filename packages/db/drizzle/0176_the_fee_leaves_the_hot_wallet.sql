CREATE TABLE "treasury_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lamports" bigint NOT NULL,
	"signature" varchar(120) NOT NULL,
	"address" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_transfers_lamports_positive" CHECK ("treasury_transfers"."lamports" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_transfers_signature_unique" ON "treasury_transfers" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "treasury_transfers_created_at_idx" ON "treasury_transfers" USING btree ("created_at");