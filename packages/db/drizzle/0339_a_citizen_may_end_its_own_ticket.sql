ALTER TYPE "public"."support_ticket_status" ADD VALUE 'withdrawn';--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "withdrawn_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_withdrawal_reason_is_a_withdrawal" CHECK ("support_tickets"."withdrawn_reason" is null or "support_tickets"."status"::text = 'withdrawn');