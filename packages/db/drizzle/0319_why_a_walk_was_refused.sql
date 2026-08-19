ALTER TABLE "account_walks" ADD COLUMN "prose_refusal_reason" text;--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_prose_refusal_reason_iff_rejected" CHECK ("account_walks"."prose_refusal_reason" is null
          or ("account_walks"."prose_status" = 'rejected'
              and length("account_walks"."prose_refusal_reason") <= 500));