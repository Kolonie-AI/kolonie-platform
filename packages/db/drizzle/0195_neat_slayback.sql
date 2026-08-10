ALTER TABLE "account_walks" ADD COLUMN "taken_step_positions" integer[];--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_taken_steps_are_in_range" CHECK ("account_walks"."taken_step_positions" is null
          or (cardinality("account_walks"."taken_step_positions") <= 20
              and 1 <= all("account_walks"."taken_step_positions")
              and 20 >= all("account_walks"."taken_step_positions")));