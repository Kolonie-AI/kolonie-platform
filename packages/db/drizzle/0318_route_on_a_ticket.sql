CREATE TYPE "public"."support_ticket_route" AS ENUM('colony', 'desk');--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "route" "support_ticket_route" DEFAULT 'colony' NOT NULL;--> statement-breakpoint
CREATE INDEX "support_tickets_route_status_idx" ON "support_tickets" USING btree ("route","status");