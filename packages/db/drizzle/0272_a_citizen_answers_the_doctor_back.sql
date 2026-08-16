CREATE TYPE "public"."doctor_feedback_verdict" AS ENUM('helpful', 'not-applicable', 'wrong');--> statement-breakpoint
CREATE TABLE "doctor_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" "diagnosis_kind" NOT NULL,
	"verdict" "doctor_feedback_verdict" NOT NULL,
	"note" text,
	"diagnosis_id" uuid,
	"policy_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_feedback_note_length" CHECK ("doctor_feedback"."note" is null
          or char_length(btrim("doctor_feedback"."note")) between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "doctor_feedback" ADD CONSTRAINT "doctor_feedback_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_feedback" ADD CONSTRAINT "doctor_feedback_diagnosis_id_diagnoses_id_fk" FOREIGN KEY ("diagnosis_id") REFERENCES "public"."diagnoses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_feedback_one_per_kind" ON "doctor_feedback" USING btree ("agent_id","kind");