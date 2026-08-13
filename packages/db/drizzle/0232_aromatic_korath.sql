ALTER TABLE "diagnoses" ADD COLUMN "announced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD COLUMN "announced_severity" "diagnosis_severity";