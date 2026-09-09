CREATE TABLE "self_direction_instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"lifecycle" varchar(16) NOT NULL,
	"cadence_days" integer NOT NULL,
	"retest_floor_hours" integer NOT NULL,
	"compatibility" jsonb NOT NULL,
	"theme_definitions" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_direction_instruments_lifecycle_known" CHECK ("self_direction_instruments"."lifecycle" in ('draft', 'pilot', 'active', 'retired')),
	CONSTRAINT "self_direction_instruments_version_positive" CHECK ("self_direction_instruments"."version" >= 1),
	CONSTRAINT "self_direction_instruments_cadence_positive" CHECK ("self_direction_instruments"."cadence_days" >= 1),
	CONSTRAINT "self_direction_instruments_retest_positive" CHECK ("self_direction_instruments"."retest_floor_hours" >= 1)
);
--> statement-breakpoint
CREATE TABLE "self_direction_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"item_key" varchar(64) NOT NULL,
	"audience" varchar(16) NOT NULL,
	"profession_tag" varchar(64),
	"scenario_kind" varchar(64) NOT NULL,
	"prompt" text NOT NULL,
	"rationale" text NOT NULL,
	"state" varchar(16) NOT NULL,
	CONSTRAINT "self_direction_items_position_positive" CHECK ("self_direction_items"."position" >= 1),
	CONSTRAINT "self_direction_items_audience_known" CHECK ("self_direction_items"."audience" in ('general', 'profession')),
	CONSTRAINT "self_direction_items_state_known" CHECK ("self_direction_items"."state" in ('active', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "self_direction_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"option_key" varchar(64) NOT NULL,
	"text" text NOT NULL,
	"weights" jsonb NOT NULL,
	"patterns" jsonb NOT NULL,
	CONSTRAINT "self_direction_options_position_positive" CHECK ("self_direction_options"."position" >= 1)
);
--> statement-breakpoint
ALTER TABLE "self_direction_items" ADD CONSTRAINT "self_direction_items_instrument_id_self_direction_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."self_direction_instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_direction_options" ADD CONSTRAINT "self_direction_options_item_id_self_direction_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."self_direction_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "self_direction_instruments_slug_version_key" ON "self_direction_instruments" USING btree ("slug","version");--> statement-breakpoint
CREATE INDEX "self_direction_instruments_lifecycle_idx" ON "self_direction_instruments" USING btree ("lifecycle");--> statement-breakpoint
CREATE UNIQUE INDEX "self_direction_items_instrument_key" ON "self_direction_items" USING btree ("instrument_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "self_direction_items_instrument_position" ON "self_direction_items" USING btree ("instrument_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "self_direction_options_item_key" ON "self_direction_options" USING btree ("item_id","option_key");--> statement-breakpoint
CREATE UNIQUE INDEX "self_direction_options_item_position" ON "self_direction_options" USING btree ("item_id","position");