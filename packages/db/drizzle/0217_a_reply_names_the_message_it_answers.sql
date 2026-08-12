CREATE TABLE "operator_telegram_asks" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_telegram_asks" ADD CONSTRAINT "operator_telegram_asks_request_id_operator_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."operator_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_telegram_asks_message_idx" ON "operator_telegram_asks" USING btree ("chat_id","message_id");