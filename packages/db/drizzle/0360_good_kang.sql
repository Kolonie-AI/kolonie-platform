CREATE TABLE "workplace_practicum_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" varchar(32) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_practicum_events_event_is_known" CHECK ("workplace_practicum_events"."event" in ('offered', 'accepted', 'deferred', 'shipped', 'failed_experiment', 'replaced', 'ended', 'documentation_only_update'))
);
--> statement-breakpoint
CREATE INDEX "workplace_practicum_events_event_idx" ON "workplace_practicum_events" USING btree ("event","at");