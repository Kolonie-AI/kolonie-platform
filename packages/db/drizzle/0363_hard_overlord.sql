CREATE TABLE "self_direction_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'open' NOT NULL,
	"presentation" jsonb NOT NULL,
	"result" jsonb,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scored_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"delegation_id" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "self_direction_attempts_state_known" CHECK ("self_direction_attempts"."state" in ('open', 'awaiting-reflection', 'closed', 'expired')),
	CONSTRAINT "self_direction_attempts_version_positive" CHECK ("self_direction_attempts"."row_version" >= 1),
	CONSTRAINT "self_direction_attempts_expiry_after_open" CHECK ("self_direction_attempts"."expires_at" > "self_direction_attempts"."opened_at")
);
--> statement-breakpoint
CREATE TABLE "self_direction_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"item_key" varchar(64) NOT NULL,
	"option_key" varchar(64) NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "self_direction_attempts" ADD CONSTRAINT "self_direction_attempts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_direction_attempts" ADD CONSTRAINT "self_direction_attempts_instrument_id_self_direction_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."self_direction_instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_direction_responses" ADD CONSTRAINT "self_direction_responses_attempt_id_self_direction_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."self_direction_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "self_direction_attempts_one_live_per_agent" ON "self_direction_attempts" USING btree ("agent_id") WHERE "self_direction_attempts"."state" in ('open', 'awaiting-reflection');--> statement-breakpoint
CREATE INDEX "self_direction_attempts_agent_opened_idx" ON "self_direction_attempts" USING btree ("agent_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "self_direction_responses_attempt_item_key" ON "self_direction_responses" USING btree ("attempt_id","item_key");