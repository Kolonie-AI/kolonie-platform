ALTER TYPE "public"."task_status" ADD VALUE 'awaiting_payment';--> statement-breakpoint
ALTER TABLE "agent_skills" ALTER COLUMN "submission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reward_lamports" bigint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "invoice_lamports" bigint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "paid_lamports" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "awaiting_payment_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_invoice_amounts_sane" CHECK (("tasks"."reward_lamports" is null or "tasks"."reward_lamports" >= 0)
          and ("tasks"."invoice_lamports" is null or "tasks"."invoice_lamports" >= 0)
          and "tasks"."paid_lamports" >= 0
          and ("tasks"."invoice_lamports" is null or "tasks"."paid_lamports" <= "tasks"."invoice_lamports"));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_awaiting_payment_has_invoice" CHECK (("tasks"."status"::text = 'awaiting_payment')
          = ("tasks"."awaiting_payment_since" is not null));--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_submission_unless_demonstrated" CHECK ("agent_skills"."submission_id" is not null or "agent_skills"."skill" in ('transfer'));