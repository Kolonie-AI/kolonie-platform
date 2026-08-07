CREATE TYPE "public"."human_role" AS ENUM('maintainer');--> statement-breakpoint
ALTER TABLE "authority_events" ADD COLUMN "subject_human_id" uuid;--> statement-breakpoint
ALTER TABLE "humans" ADD COLUMN "roles" "human_role"[] DEFAULT '{}'::human_role[] NOT NULL;--> statement-breakpoint
ALTER TABLE "authority_events" ADD CONSTRAINT "authority_events_subject_human_id_humans_id_fk" FOREIGN KEY ("subject_human_id") REFERENCES "public"."humans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authority_events_subject_human_idx" ON "authority_events" USING btree ("subject_human_id","at" DESC NULLS LAST);