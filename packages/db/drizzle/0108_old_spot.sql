CREATE TABLE "memory_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"code" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"wrong_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "memory_codes_one_ending" CHECK ("memory_codes"."redeemed_at" is null or "memory_codes"."superseded_at" is null),
	CONSTRAINT "memory_codes_wrong_attempts_positive" CHECK ("memory_codes"."wrong_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "memory_codes" ADD CONSTRAINT "memory_codes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_codes_one_outstanding_per_agent" ON "memory_codes" USING btree ("agent_id") WHERE "memory_codes"."redeemed_at" is null and "memory_codes"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "memory_codes_agent_redeemed_idx" ON "memory_codes" USING btree ("agent_id","redeemed_at");