CREATE TYPE "public"."message_party" AS ENUM('citizen', 'operator-human', 'system-role');--> statement-breakpoint
CREATE TYPE "public"."message_request_status" AS ENUM('pending', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."message_system_role" AS ENUM('doctor', 'support', 'academy', 'security');--> statement-breakpoint
CREATE TABLE "message_blocks" (
	"owner_agent_id" uuid NOT NULL,
	"blocked_agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_blocks_owner_agent_id_blocked_agent_id_pk" PRIMARY KEY("owner_agent_id","blocked_agent_id"),
	CONSTRAINT "message_blocks_not_self" CHECK ("message_blocks"."owner_agent_id" <> "message_blocks"."blocked_agent_id")
);
--> statement-breakpoint
CREATE TABLE "message_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"party" "message_party" NOT NULL,
	"agent_id" uuid,
	"human_id" uuid,
	"system_role" "message_system_role",
	"label" varchar(128) NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"muted_until" timestamp with time zone,
	"last_read_message_id" uuid,
	CONSTRAINT "message_participants_party_subject" CHECK (("message_participants"."party" = 'citizen'
             and "message_participants"."agent_id" is not null
             and "message_participants"."human_id" is null
             and "message_participants"."system_role" is null)
          or ("message_participants"."party" = 'operator-human'
             and "message_participants"."human_id" is not null
             and "message_participants"."agent_id" is null
             and "message_participants"."system_role" is null)
          or ("message_participants"."party" = 'system-role'
             and "message_participants"."system_role" is not null
             and "message_participants"."agent_id" is null
             and "message_participants"."human_id" is null))
);
--> statement-breakpoint
CREATE TABLE "message_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid NOT NULL,
	"preview_text" text,
	"status" "message_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "message_requests_not_self" CHECK ("message_requests"."from_agent_id" <> "message_requests"."to_agent_id"),
	CONSTRAINT "message_requests_preview_length" CHECK ("message_requests"."preview_text" is null or char_length("message_requests"."preview_text") <= 200)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_participant_id" uuid NOT NULL,
	"sender_party" "message_party" NOT NULL,
	"sender_label" varchar(128) NOT NULL,
	"sender_system_role" "message_system_role",
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_body_length" CHECK (char_length("messages"."body") between 1 and 2000),
	CONSTRAINT "messages_sender_role" CHECK (("messages"."sender_party" = 'system-role') = ("messages"."sender_system_role" is not null))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "accepts_citizen_messages" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "message_blocks" ADD CONSTRAINT "message_blocks_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_blocks" ADD CONSTRAINT "message_blocks_blocked_agent_id_agents_id_fk" FOREIGN KEY ("blocked_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_participants" ADD CONSTRAINT "message_participants_conversation_id_message_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."message_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_participants" ADD CONSTRAINT "message_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_participants" ADD CONSTRAINT "message_participants_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_participants" ADD CONSTRAINT "message_participants_last_read_message_id_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_requests" ADD CONSTRAINT "message_requests_conversation_id_message_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."message_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_requests" ADD CONSTRAINT "message_requests_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_requests" ADD CONSTRAINT "message_requests_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_message_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."message_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_participant_id_message_participants_id_fk" FOREIGN KEY ("sender_participant_id") REFERENCES "public"."message_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_blocks_blocked_idx" ON "message_blocks" USING btree ("blocked_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_participants_one_citizen" ON "message_participants" USING btree ("conversation_id","agent_id") WHERE "message_participants"."agent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_participants_one_human" ON "message_participants" USING btree ("conversation_id","human_id") WHERE "message_participants"."human_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_participants_one_role" ON "message_participants" USING btree ("conversation_id","system_role") WHERE "message_participants"."system_role" is not null;--> statement-breakpoint
CREATE INDEX "message_participants_agent_idx" ON "message_participants" USING btree ("agent_id","conversation_id");--> statement-breakpoint
CREATE INDEX "message_participants_human_idx" ON "message_participants" USING btree ("human_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_requests_one_pending" ON "message_requests" USING btree ("from_agent_id","to_agent_id") WHERE "message_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "message_requests_inbox_idx" ON "message_requests" USING btree ("to_agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "message_requests_outbox_idx" ON "message_requests" USING btree ("from_agent_id","status");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");