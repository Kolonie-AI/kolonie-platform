CREATE TABLE "workplace_outcome_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"result" varchar(32) NOT NULL,
	"evidence_present" boolean NOT NULL,
	"is_revision" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_outcome_events_result_is_known" CHECK ("workplace_outcome_events"."result" in ('shipped', 'failed_experiment', 'abandoned', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX "workplace_outcome_events_at_idx" ON "workplace_outcome_events" USING btree ("at");