CREATE TYPE "public"."diagnosis_kind" AS ENUM('polling-loop', 'oversized-reads', 'retry-storm', 'no-progress', 'stalled-arrival', 'deprecated-route');--> statement-breakpoint
CREATE TYPE "public"."diagnosis_scope" AS ENUM('agent', 'colony');--> statement-breakpoint
CREATE TYPE "public"."diagnosis_severity" AS ENUM('notice', 'concern', 'serious');--> statement-breakpoint
CREATE TYPE "public"."diagnosis_state" AS ENUM('open', 'resolved', 'superseded');--> statement-breakpoint
CREATE TABLE "diagnoses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "diagnosis_scope" NOT NULL,
	"agent_id" uuid,
	"subject" text NOT NULL,
	"kind" "diagnosis_kind" NOT NULL,
	"severity" "diagnosis_severity" NOT NULL,
	"confidence" real NOT NULL,
	"evidence" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"state" "diagnosis_state" DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observations" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"prose" text,
	"prose_model" text,
	"support_ticket_id" uuid,
	CONSTRAINT "diagnoses_policy_version_not_blank" CHECK (length(trim("diagnoses"."policy_version")) > 0),
	CONSTRAINT "diagnoses_scope_names_its_subject" CHECK (("diagnoses"."scope" = 'agent' and "diagnoses"."agent_id" is not null)
          or ("diagnoses"."scope" = 'colony' and "diagnoses"."agent_id" is null))
);
--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_support_ticket_id_support_tickets_id_fk" FOREIGN KEY ("support_ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "diagnoses_open_unique" ON "diagnoses" USING btree ("scope","subject","kind","policy_version") WHERE "diagnoses"."state" = 'open';--> statement-breakpoint
CREATE INDEX "diagnoses_subject_idx" ON "diagnoses" USING btree ("subject","state");--> statement-breakpoint
CREATE INDEX "diagnoses_open_idx" ON "diagnoses" USING btree ("state","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "diagnoses_agent_idx" ON "diagnoses" USING btree ("agent_id");