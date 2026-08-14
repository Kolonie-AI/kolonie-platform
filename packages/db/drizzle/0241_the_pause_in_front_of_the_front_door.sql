CREATE TABLE "registration_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name_key" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "registration_confirmations_expiry_after_creation" CHECK ("registration_confirmations"."expires_at" > "registration_confirmations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "registration_confirmations_token_unique" ON "registration_confirmations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "registration_confirmations_open_idx" ON "registration_confirmations" USING btree ("expires_at") WHERE "registration_confirmations"."consumed_at" is null;