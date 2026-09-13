CREATE TABLE "message_retraction_evidence" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_requests" ADD COLUMN "preview_message_id" uuid;--> statement-breakpoint
UPDATE "message_requests" AS "request"
SET "preview_message_id" = (
	SELECT "message"."id"
	FROM "messages" AS "message"
	WHERE "message"."conversation_id" = "request"."conversation_id"
	ORDER BY "message"."created_at" ASC, "message"."id" ASC
	LIMIT 1
);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "retracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_retraction_evidence" ADD CONSTRAINT "message_retraction_evidence_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_requests" ADD CONSTRAINT "message_requests_preview_message_id_messages_id_fk" FOREIGN KEY ("preview_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;