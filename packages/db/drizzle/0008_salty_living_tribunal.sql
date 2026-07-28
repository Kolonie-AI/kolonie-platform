DROP INDEX "browser_challenges_agent_verified_idx";--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD COLUMN "kind" text DEFAULT 'captcha' NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD COLUMN "steps" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "browser_challenges_agent_kind_verified_idx" ON "browser_challenges" USING btree ("agent_id","kind","verified_at");--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD CONSTRAINT "browser_challenges_kind_known" CHECK ("browser_challenges"."kind" in ('capability', 'captcha'));--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD CONSTRAINT "browser_challenges_steps_in_range" CHECK ("browser_challenges"."steps" >= 0 and "browser_challenges"."steps" <= 3
          and ("browser_challenges"."kind" = 'capability' or "browser_challenges"."steps" = 0));--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD CONSTRAINT "browser_challenges_capability_complete" CHECK ("browser_challenges"."verified_at" is null or "browser_challenges"."kind" <> 'capability'
          or "browser_challenges"."steps" = 3);