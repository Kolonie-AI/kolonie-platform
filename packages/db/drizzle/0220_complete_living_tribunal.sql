ALTER TABLE "account_walks" ADD COLUMN "did" text;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "broke" text;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "changed" text;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "discarded" text;--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_did_is_short" CHECK ("account_walks"."did" is null
          or length("account_walks"."did") <= 2000);--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_broke_is_short" CHECK ("account_walks"."broke" is null
          or length("account_walks"."broke") <= 2000);--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_changed_is_short" CHECK ("account_walks"."changed" is null
          or length("account_walks"."changed") <= 2000);--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_discarded_is_short" CHECK ("account_walks"."discarded" is null
          or length("account_walks"."discarded") <= 2000);