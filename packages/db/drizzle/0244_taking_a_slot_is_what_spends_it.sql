ALTER TABLE "account_slots" ADD COLUMN "taken_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "taken_to" text;--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_taken_is_a_secret" CHECK ("account_slots"."taken_at" is null or ("account_slots"."secret" and "account_slots"."filled_at" is not null));--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_taken_together" CHECK (("account_slots"."taken_at" is null and "account_slots"."taken_to" is null)
          or ("account_slots"."taken_at" is not null and "account_slots"."taken_to" is not null));