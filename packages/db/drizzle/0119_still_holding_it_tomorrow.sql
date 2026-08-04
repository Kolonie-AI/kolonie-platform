CREATE TABLE "totp_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"proved_at" timestamp with time zone,
	"held_at" timestamp with time zone,
	"wrong_attempts" integer DEFAULT 0 NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "totp_secrets_held_after_proved" CHECK ("totp_secrets"."held_at" is null or ("totp_secrets"."proved_at" is not null and "totp_secrets"."held_at" >= "totp_secrets"."proved_at"))
);
--> statement-breakpoint
ALTER TABLE "totp_secrets" ADD CONSTRAINT "totp_secrets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "totp_secrets_agent_live_idx" ON "totp_secrets" USING btree ("agent_id","superseded_at");