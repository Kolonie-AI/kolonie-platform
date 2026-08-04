CREATE TYPE "public"."provider_report_outcome" AS ENUM('signup-refused', 'never-provisioned', 'abandoned');--> statement-breakpoint
CREATE TABLE "provider_reports" (
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"outcome" "provider_report_outcome" NOT NULL,
	"noted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_reports_agent_id_kind_provider_pk" PRIMARY KEY("agent_id","kind","provider")
);
--> statement-breakpoint
ALTER TABLE "provider_reports" ADD CONSTRAINT "provider_reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;