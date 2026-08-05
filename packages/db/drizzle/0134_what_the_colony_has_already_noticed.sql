CREATE TABLE "log_defects" (
	"signature" text PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrences" bigint DEFAULT 0 NOT NULL,
	"issue_url" text,
	"issue_filed_at" timestamp with time zone,
	"last_comment_at" timestamp with time zone,
	"regressions" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "log_defects_filed_together" CHECK (("log_defects"."issue_url" is null) = ("log_defects"."issue_filed_at" is null)),
	CONSTRAINT "log_defects_seen_in_order" CHECK ("log_defects"."last_seen_at" >= "log_defects"."first_seen_at")
);
--> statement-breakpoint
CREATE INDEX "log_defects_filed_idx" ON "log_defects" USING btree ("issue_filed_at");