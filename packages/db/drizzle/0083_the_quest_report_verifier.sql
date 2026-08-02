CREATE TABLE "quest_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_answers_question_key_shape" CHECK ("quest_answers"."question_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "quest_answers_text_length" CHECK (char_length("quest_answers"."text") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "proof_verifier" varchar(64);--> statement-breakpoint
ALTER TABLE "quest_answers" ADD CONSTRAINT "quest_answers_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_answers" ADD CONSTRAINT "quest_answers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quest_answers_one_per_question" ON "quest_answers" USING btree ("submission_id","question_key");--> statement-breakpoint
CREATE INDEX "quest_answers_task_idx" ON "quest_answers" USING btree ("task_id","question_key");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_questions_belong_to_quests" CHECK ("tasks"."kind" = 'quest' or "tasks"."questions" = '[]'::jsonb);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_proof_verifier_belongs_to_quests" CHECK ("tasks"."kind" = 'quest' or "tasks"."proof_verifier" is null);