ALTER TABLE "task_attempts" ADD COLUMN "operator_asked" boolean;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "operator_asked_for" text;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "operator_acted" boolean;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_operator_answers_hang_on_asking" CHECK ("task_attempts"."operator_asked" is true
          or ("task_attempts"."operator_acted" is null and "task_attempts"."operator_asked_for" is null));--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_operator_asked_for_length" CHECK ("task_attempts"."operator_asked_for" is null or char_length("task_attempts"."operator_asked_for") <= 500);