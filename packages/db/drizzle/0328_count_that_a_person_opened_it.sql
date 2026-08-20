ALTER TABLE "vault_shares" ADD COLUMN "taken_back_by" text;--> statement-breakpoint
ALTER TABLE "vault_shares" ADD COLUMN "reads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_shares" ADD COLUMN "last_read_at" timestamp with time zone;