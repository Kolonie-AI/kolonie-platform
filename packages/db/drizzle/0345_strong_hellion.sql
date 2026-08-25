CREATE TABLE "credential_rotation_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "credential_rotation_confirmations_expiry_after_creation" CHECK ("credential_rotation_confirmations"."expires_at" > "credential_rotation_confirmations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "credential_rotation_confirmations" ADD CONSTRAINT "credential_rotation_confirmations_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_rotation_confirmations_token_unique" ON "credential_rotation_confirmations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "credential_rotation_confirmations_open_idx" ON "credential_rotation_confirmations" USING btree ("expires_at") WHERE "credential_rotation_confirmations"."consumed_at" is null;