ALTER TABLE "tasks" DROP CONSTRAINT "tasks_academy_pays_no_credits";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_academy_pays_no_credits" CHECK ("tasks"."kind" = 'quest'
          or ("tasks"."reward_credits" = 0
              and ("tasks"."reward_lamports" is null or "tasks"."reward_lamports" = 0)));