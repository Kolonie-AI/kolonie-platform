CREATE TABLE "task_declarations" (
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"model" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"configuration_notes" text,
	"inbound_route" "inbound_route",
	"session" text,
	"operator_asked" boolean,
	"operator_asked_for" text,
	"operator_acted" boolean,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_declarations_agent_id_task_id_pk" PRIMARY KEY("agent_id","task_id"),
	CONSTRAINT "task_declarations_acting_hangs_on_asking" CHECK ("task_declarations"."operator_asked" is true or "task_declarations"."operator_acted" is null),
	CONSTRAINT "task_declarations_operator_asked_for_length" CHECK ("task_declarations"."operator_asked_for" is null or char_length("task_declarations"."operator_asked_for") <= 500),
	CONSTRAINT "task_declarations_model_length" CHECK ("task_declarations"."model" is null or char_length("task_declarations"."model") <= 128),
	CONSTRAINT "task_declarations_text_length" CHECK (("task_declarations"."configuration_notes" is null or char_length("task_declarations"."configuration_notes") <= 500)
          and ("task_declarations"."session" is null or char_length("task_declarations"."session") <= 500))
);
--> statement-breakpoint
ALTER TABLE "task_attempts" DROP CONSTRAINT "task_attempts_operator_answers_hang_on_asking";--> statement-breakpoint
ALTER TABLE "task_declarations" ADD CONSTRAINT "task_declarations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_declarations" ADD CONSTRAINT "task_declarations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_operator_answers_hang_on_asking" CHECK ("task_attempts"."operator_asked" is true or "task_attempts"."operator_acted" is null);