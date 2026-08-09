ALTER TABLE "account_walks" DROP CONSTRAINT "account_walks_note_is_short";--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_note_is_short" CHECK ("account_walks"."note" is null
          or length("account_walks"."note") <= 2000);