ALTER TABLE "account_slots" ADD COLUMN "awaits" "slot_filler" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "vault_key" varchar(128);--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "reads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "destroyed_at" timestamp with time zone;--> statement-breakpoint
-- Hand-added, and both statements are here because two of the constraints below
-- are biconditionals that rows written before this migration cannot satisfy.
-- A slot that already carries a secret gets the same seven days a new one gets,
-- counted from the migration; a slot already filled says so in `awaits`, which
-- is the column that used to be implied by `filled_by` alone.
UPDATE "account_slots" SET "awaits" = "filled_by" WHERE "filled_by" is not null;--> statement-breakpoint
UPDATE "account_slots" SET "expires_at" = now() + interval '7 days' WHERE "secret" and "expires_at" is null;--> statement-breakpoint
CREATE INDEX "account_slots_expiry_idx" ON "account_slots" USING btree ("expires_at") WHERE "account_slots"."destroyed_at" is null and "account_slots"."expires_at" is not null;--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_filled_by_the_awaited" CHECK ("account_slots"."filled_by" is null or "account_slots"."filled_by" = "account_slots"."awaits");--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_vault_key_is_for_the_operator" CHECK ("account_slots"."vault_key" is null or ("account_slots"."secret" and "account_slots"."awaits" = 'operator'));--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_secrets_expire" CHECK (("account_slots"."expires_at" is not null) = "account_slots"."secret");--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_reads_bounded" CHECK ("account_slots"."reads" >= 0 and "account_slots"."reads" <= 3);--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_reads_are_a_secrets" CHECK ("account_slots"."reads" = 0 or "account_slots"."secret");--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_destroyed_holds_nothing" CHECK ("account_slots"."destroyed_at" is null or "account_slots"."value" is null);