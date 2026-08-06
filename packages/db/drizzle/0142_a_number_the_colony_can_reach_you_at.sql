CREATE TYPE "public"."sms_challenge_purpose" AS ENUM('receive', 'send');--> statement-breakpoint
CREATE TABLE "sms_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"number" text,
	"purpose" "sms_challenge_purpose" NOT NULL,
	"code" text,
	"nonce" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"send_failure" text,
	"inbound_at" timestamp with time zone,
	"inbound_from" text,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sms_challenges" ADD CONSTRAINT "sms_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_challenges_agent_created_idx" ON "sms_challenges" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "sms_challenges_nonce_idx" ON "sms_challenges" USING btree ("nonce") WHERE "sms_challenges"."nonce" is not null;