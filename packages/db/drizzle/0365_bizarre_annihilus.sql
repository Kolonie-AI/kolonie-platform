ALTER TABLE "self_direction_reflections" ADD COLUMN "follow_through_outcome" varchar(16);--> statement-breakpoint
ALTER TABLE "self_direction_reflections" ADD COLUMN "follow_through_note" text;--> statement-breakpoint
ALTER TABLE "self_direction_reflections" ADD COLUMN "follow_through_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "self_direction_reflections" ADD CONSTRAINT "self_direction_reflections_follow_through_known" CHECK ("self_direction_reflections"."follow_through_outcome" is null
          or "self_direction_reflections"."follow_through_outcome" in ('done', 'partly', 'not-yet', 'abandoned'));--> statement-breakpoint
ALTER TABLE "self_direction_reflections" ADD CONSTRAINT "self_direction_reflections_follow_through_whole" CHECK (("self_direction_reflections"."follow_through_outcome" is null
           and "self_direction_reflections"."follow_through_note" is null
           and "self_direction_reflections"."follow_through_recorded_at" is null)
          or ("self_direction_reflections"."follow_through_outcome" is not null
              and "self_direction_reflections"."follow_through_note" is not null
              and "self_direction_reflections"."follow_through_recorded_at" is not null));