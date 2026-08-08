CREATE TYPE "public"."wake_delivery_outcome" AS ENUM('answered', 'refused', 'timed-out', 'dns-failed', 'tls-failed', 'not-public', 'failed', 'capped', 'no-address');--> statement-breakpoint
CREATE TYPE "public"."wake_event" AS ENUM('operator-answer', 'verdict', 'quest-opened');--> statement-breakpoint
CREATE TABLE "wake_addresses" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"proved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_knocked_at" timestamp with time zone,
	"last_outcome" "wake_delivery_outcome",
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "wake_addresses_failures_not_negative" CHECK ("wake_addresses"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wake_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"knock_nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wake_challenges_expiry_after_creation" CHECK ("wake_challenges"."expires_at" > "wake_challenges"."created_at")
);
--> statement-breakpoint
CREATE TABLE "wake_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"event" "wake_event" NOT NULL,
	"outcome" "wake_delivery_outcome" NOT NULL,
	"status" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wake_addresses" ADD CONSTRAINT "wake_addresses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_challenges" ADD CONSTRAINT "wake_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wake_deliveries" ADD CONSTRAINT "wake_deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wake_challenges_agent_expiry_idx" ON "wake_challenges" USING btree ("agent_id","expires_at");--> statement-breakpoint
CREATE INDEX "wake_deliveries_agent_at_idx" ON "wake_deliveries" USING btree ("agent_id","at");