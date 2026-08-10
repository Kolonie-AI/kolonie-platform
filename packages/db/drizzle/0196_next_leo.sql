ALTER TABLE "autonomy_contracts" DROP CONSTRAINT "autonomy_contracts_pkey";--> statement-breakpoint
ALTER TABLE "autonomy_contracts" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "autonomy_contracts" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "autonomy_contracts_live_agent_idx" ON "autonomy_contracts" USING btree ("agent_id") WHERE "autonomy_contracts"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "autonomy_contracts_agent_recorded_idx" ON "autonomy_contracts" USING btree ("agent_id","recorded_at");
