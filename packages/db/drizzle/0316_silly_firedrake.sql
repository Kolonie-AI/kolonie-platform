ALTER TABLE "message_conversations" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "message_conversations" ADD COLUMN "wish_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "answer_kind" "operator_answer_kind";--> statement-breakpoint
ALTER TABLE "message_conversations" ADD CONSTRAINT "message_conversations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_conversations" ADD CONSTRAINT "message_conversations_wish_id_account_wishes_id_fk" FOREIGN KEY ("wish_id") REFERENCES "public"."account_wishes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_conversations_task_idx" ON "message_conversations" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "message_conversations" ADD CONSTRAINT "message_conversations_provenance" CHECK ("message_conversations"."task_id" is null or "message_conversations"."wish_id" is null);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_answer_kind_party" CHECK ("messages"."answer_kind" is null or "messages"."sender_party" = 'operator-human');