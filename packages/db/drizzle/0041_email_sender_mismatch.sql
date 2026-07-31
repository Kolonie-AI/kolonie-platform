ALTER TABLE "email_challenges" ADD COLUMN "mismatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_challenges" ADD COLUMN "mismatched_from" text;--> statement-breakpoint
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_mismatch_is_whole" CHECK (("email_challenges"."mismatched_from" is null) = ("email_challenges"."mismatched_at" is null));--> statement-breakpoint
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_mismatched_from_length" CHECK ("email_challenges"."mismatched_from" is null or char_length("email_challenges"."mismatched_from") <= 320);
