CREATE TABLE "message_telegram_asks" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_telegram_asks" ADD CONSTRAINT "message_telegram_asks_conversation_id_message_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."message_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_telegram_asks_message_idx" ON "message_telegram_asks" USING btree ("chat_id","message_id");