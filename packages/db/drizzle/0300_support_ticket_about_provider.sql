ALTER TABLE "support_tickets" ADD COLUMN "about_provider_kind" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "about_provider_name" text;--> statement-breakpoint
ALTER TABLE "provider_briefings" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_about_provider_is_a_pair" CHECK (("support_tickets"."about_provider_kind" is null) = ("support_tickets"."about_provider_name" is null));