CREATE TABLE "message_conversation_shares" (
	"conversation_id" uuid NOT NULL,
	"share_id" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_conversation_shares_conversation_id_share_id_pk" PRIMARY KEY("conversation_id","share_id")
);
--> statement-breakpoint
ALTER TABLE "message_conversations" DROP CONSTRAINT "message_conversations_provenance";--> statement-breakpoint
ALTER TABLE "message_conversations" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "message_conversation_shares" ADD CONSTRAINT "message_conversation_shares_conversation_id_message_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."message_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_conversation_shares" ADD CONSTRAINT "message_conversation_shares_share_id_vault_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."vault_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_conversation_shares_conversation_idx" ON "message_conversation_shares" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "message_conversations" ADD CONSTRAINT "message_conversations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_conversations_account_idx" ON "message_conversations" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "message_conversations" ADD CONSTRAINT "message_conversations_provenance" CHECK (("message_conversations"."task_id" is not null)::int + ("message_conversations"."wish_id" is not null)::int
          + ("message_conversations"."account_id" is not null)::int <= 1);