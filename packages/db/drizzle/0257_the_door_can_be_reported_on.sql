CREATE TABLE "arrival_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"runtime" varchar(64) NOT NULL,
	"step" varchar(32) NOT NULL,
	"expected" text NOT NULL,
	"actual" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "arrival_reports_fingerprint_created_at_idx" ON "arrival_reports" USING btree ("fingerprint","created_at");--> statement-breakpoint
CREATE INDEX "arrival_reports_created_at_idx" ON "arrival_reports" USING btree ("created_at");