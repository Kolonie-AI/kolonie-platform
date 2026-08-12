CREATE TABLE "operator_telegram_chats" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unreachable_at" timestamp with time zone,
	CONSTRAINT "operator_telegram_chats_private" CHECK ("operator_telegram_chats"."chat_id" > 0)
);
--> statement-breakpoint
CREATE TABLE "operator_telegram_starts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "operator_telegram_chats" ADD CONSTRAINT "operator_telegram_chats_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_telegram_starts" ADD CONSTRAINT "operator_telegram_starts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_telegram_chats_chat_idx" ON "operator_telegram_chats" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_telegram_starts_token_idx" ON "operator_telegram_starts" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_telegram_starts_live_idx" ON "operator_telegram_starts" USING btree ("agent_id") WHERE "operator_telegram_starts"."redeemed_at" is null;