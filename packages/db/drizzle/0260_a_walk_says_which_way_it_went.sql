ALTER TABLE "account_walks" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_direction_is_known" CHECK ("account_walks"."direction" is null
          or ("account_walks"."direction" in ('inbound', 'outbound', 'both')
              and "account_walks"."kind" in ('phone')));