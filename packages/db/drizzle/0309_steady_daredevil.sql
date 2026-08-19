CREATE TYPE "public"."message_priority" AS ENUM('normal', 'elevated', 'critical');--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "priority" "message_priority";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "action_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "next_action" varchar(128);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_system_fields" CHECK (("messages"."sender_party" = 'system-role')
          or (
            "messages"."priority" is null
            and "messages"."action_required" = false
            and "messages"."next_action" is null
            and "messages"."acknowledged_at" is null
          ));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_next_action_length" CHECK ("messages"."next_action" is null or char_length("messages"."next_action") between 1 and 128);