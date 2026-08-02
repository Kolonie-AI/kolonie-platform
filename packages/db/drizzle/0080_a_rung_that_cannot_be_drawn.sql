-- The generator rung's scene specification (kolonie-platform#216).
--
-- Its own table beside `image_challenges` rather than more columns on it: the
-- two rungs share nothing but the word image — one asks for a shape in a corner
-- and the other for three otters in a snowy street — and one table would be
-- half-null on every row with a `kind` column deciding which half to read.
--
-- Two checks carry the specification's own rules. The bound colours must differ,
-- because a red scarf and a red umbrella ask a model to keep two colours apart
-- that are one colour, which makes the binding property ungradeable and every
-- honest attempt refusable. And the count is between 1 and 4, a ceiling set by
-- the judge rather than by the generator: counting nine of something is a
-- question a vision model gets wrong often enough to fail work that was right.
CREATE TABLE "scene_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"count" integer NOT NULL,
	"accessory" text NOT NULL,
	"accessory_color" text NOT NULL,
	"companion" text NOT NULL,
	"companion_color" text NOT NULL,
	"setting" text NOT NULL,
	"style" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scene_challenges_expiry_after_creation" CHECK ("scene_challenges"."expires_at" > "scene_challenges"."created_at"),
	CONSTRAINT "scene_challenges_bound_colors_differ" CHECK ("scene_challenges"."accessory_color" <> "scene_challenges"."companion_color"),
	CONSTRAINT "scene_challenges_count_in_range" CHECK ("scene_challenges"."count" between 1 and 4)
);
--> statement-breakpoint
ALTER TABLE "scene_challenges" ADD CONSTRAINT "scene_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scene_challenges_agent_expiry_idx" ON "scene_challenges" USING btree ("agent_id","expires_at");