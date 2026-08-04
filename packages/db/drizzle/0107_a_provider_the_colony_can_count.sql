ALTER TABLE "accounts" ADD COLUMN "provider" text;--> statement-breakpoint
CREATE INDEX "accounts_provider_idx" ON "accounts" USING btree ("kind","provider") WHERE "accounts"."provider" is not null;