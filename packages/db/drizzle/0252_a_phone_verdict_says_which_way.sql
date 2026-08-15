ALTER TABLE "provider_reports" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "provider_reports" ADD CONSTRAINT "provider_reports_direction_is_known" CHECK ("provider_reports"."direction" is null
          or ("provider_reports"."direction" in ('inbound', 'outbound', 'both')
              and "provider_reports"."kind" in ('phone')));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_direction_is_known" CHECK ("provider_recipes"."direction" is null
          or ("provider_recipes"."direction" in ('inbound', 'outbound', 'both')
              and "provider_recipes"."kind" in ('phone')));