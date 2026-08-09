ALTER TABLE "support_tickets" DROP CONSTRAINT "support_tickets_settled_says_why";--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_settled_says_why" CHECK ("support_tickets"."kind"::text = 'notice'
          or "support_tickets"."status" not in ('resolved', 'declined')
          or "support_tickets"."resolution" is not null);