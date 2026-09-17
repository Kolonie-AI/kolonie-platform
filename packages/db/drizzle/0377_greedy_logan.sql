UPDATE "accounts"
   SET "provider" = null
 WHERE "provider" is not null
   and ("provider" !~ '^[a-z0-9][a-z0-9.+_-]*$' or char_length("provider") > 128);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_provider_is_a_token" CHECK ("accounts"."provider" is null
          or ("accounts"."provider" ~ '^[a-z0-9][a-z0-9.+_-]*$'
              and char_length("accounts"."provider") <= 128));