CREATE TABLE "self_direction_reflections" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"decision" varchar(16) NOT NULL,
	"outward_kind" varchar(24) NOT NULL,
	"outward_action" text NOT NULL,
	"summary" text,
	"expected_effect" text,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_direction_reflections_decision_known" CHECK ("self_direction_reflections"."decision" in ('changed', 'unchanged')),
	CONSTRAINT "self_direction_reflections_outward_kind_known" CHECK ("self_direction_reflections"."outward_kind" in ('ship', 'contact', 'spend', 'build', 'own-machine')),
	CONSTRAINT "self_direction_reflections_decision_fields" CHECK (("self_direction_reflections"."decision" = 'changed' and "self_direction_reflections"."summary" is not null and "self_direction_reflections"."expected_effect" is not null and "self_direction_reflections"."reason" is null)
          or ("self_direction_reflections"."decision" = 'unchanged' and "self_direction_reflections"."reason" is not null and "self_direction_reflections"."summary" is null and "self_direction_reflections"."expected_effect" is null))
);
--> statement-breakpoint
ALTER TABLE "self_direction_reflections" ADD CONSTRAINT "self_direction_reflections_attempt_id_self_direction_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."self_direction_attempts"("id") ON DELETE cascade ON UPDATE no action;