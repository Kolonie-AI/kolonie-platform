ALTER TABLE "account_offers" ADD COLUMN "set_id" uuid;--> statement-breakpoint
CREATE INDEX "account_offers_set_idx" ON "account_offers" USING btree ("set_id");