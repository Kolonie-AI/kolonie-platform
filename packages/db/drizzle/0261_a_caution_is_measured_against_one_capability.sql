ALTER TABLE "provider_recipes" ADD COLUMN "cautions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "provider_recipes"
   SET "cautions" = jsonb_build_array(jsonb_build_object('text', "caution", 'direction', "direction"))
 WHERE "caution" is not null;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_cautions_are_scoped" CHECK (jsonb_typeof("provider_recipes"."cautions") = 'array'
          and jsonb_array_length("provider_recipes"."cautions") <= 4
          and not jsonb_path_exists(
            "provider_recipes"."cautions",
            '$[*] ? (@.direction != null && @.direction != "inbound" && @.direction != "outbound" && @.direction != "both")'
          )
          and ("provider_recipes"."kind" in ('phone')
               or not jsonb_path_exists("provider_recipes"."cautions", '$[*] ? (@.direction != null)')));--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP COLUMN "caution";
