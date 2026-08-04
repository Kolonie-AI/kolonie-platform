ALTER TYPE "public"."email_challenge_purpose" ADD VALUE 'recheck';--> statement-breakpoint
ALTER TABLE "email_challenges" DROP CONSTRAINT "email_challenges_code_belongs_to_inbox";--> statement-breakpoint
ALTER TABLE "email_challenges" DROP CONSTRAINT "email_challenges_verdict_needs_its_evidence";--> statement-breakpoint
ALTER TABLE "email_challenges" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "email_challenges" ADD COLUMN "delivery_failure" text;--> statement-breakpoint
ALTER TABLE "email_challenges" ADD COLUMN "delivery_failure_permanent" boolean;--> statement-breakpoint
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_code_belongs_to_inbox" CHECK (case when "email_challenges"."purpose" = 'inbox' or "email_challenges"."account_id" is not null
            then "email_challenges"."sent_at" is null or "email_challenges"."code" is not null
            else "email_challenges"."code" is null and "email_challenges"."sent_at" is null
          end);--> statement-breakpoint
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_verdict_needs_its_evidence" CHECK ("email_challenges"."verified_at" is null
          or case when "email_challenges"."purpose" = 'inbox' or "email_challenges"."account_id" is not null
                 then "email_challenges"."sent_at" is not null
                 else "email_challenges"."inbound_at" is not null
             end);