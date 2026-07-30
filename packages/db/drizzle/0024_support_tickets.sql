CREATE TYPE "public"."support_ticket_kind" AS ENUM('defect', 'question', 'objection');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_status" AS ENUM('open', 'acknowledged', 'resolved', 'declined');--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" "support_ticket_kind" NOT NULL,
	"subject" varchar(160) NOT NULL,
	"body" text NOT NULL,
	"status" "support_ticket_status" DEFAULT 'open' NOT NULL,
	"resolution" varchar(2000),
	"issue_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_subject_length" CHECK (char_length("support_tickets"."subject") between 8 and 160),
	CONSTRAINT "support_tickets_body_length" CHECK (char_length("support_tickets"."body") between 30 and 6000),
	CONSTRAINT "support_tickets_settled_says_why" CHECK ("support_tickets"."status" not in ('resolved', 'declined') or "support_tickets"."resolution" is not null),
	CONSTRAINT "support_tickets_issue_means_looked_at" CHECK ("support_tickets"."issue_url" is null or "support_tickets"."status" <> 'open')
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_tickets_agent_id_created_at_idx" ON "support_tickets" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_tickets_open_idx" ON "support_tickets" USING btree ("created_at") WHERE "support_tickets"."status" in ('open', 'acknowledged');