CREATE TABLE "sms_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"to" text NOT NULL,
	"vendor_id" text NOT NULL,
	"price_amount" text,
	"price_currency" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sms_sends" ADD CONSTRAINT "sms_sends_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_sends_agent_sent_idx" ON "sms_sends" USING btree ("agent_id","sent_at");--> statement-breakpoint
CREATE INDEX "sms_sends_sent_idx" ON "sms_sends" USING btree ("sent_at");