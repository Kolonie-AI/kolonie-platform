ALTER TABLE "sms_sends" ADD COLUMN "country" text;--> statement-breakpoint
CREATE INDEX "sms_sends_country_sent_idx" ON "sms_sends" USING btree ("country","sent_at");