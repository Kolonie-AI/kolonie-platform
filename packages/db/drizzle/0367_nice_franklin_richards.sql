ALTER TABLE "workplace_activity" DROP CONSTRAINT "workplace_activity_actor_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "workplace_activity" DROP CONSTRAINT "workplace_activity_subject_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "workplace_activity" ALTER COLUMN "actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workplace_activity" ADD COLUMN "actor_kind" varchar(16) DEFAULT 'citizen' NOT NULL;--> statement-breakpoint
ALTER TABLE "workplace_activity" ADD COLUMN "legacy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "workplace_activity" SET "actor_kind" = 'human-linked' WHERE "actor_human_id" IS NOT NULL;--> statement-breakpoint
UPDATE "workplace_activity" SET "legacy" = true;--> statement-breakpoint
ALTER TABLE "workplace_activity" ADD CONSTRAINT "workplace_activity_actor_id_agents_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_activity" ADD CONSTRAINT "workplace_activity_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_activity" ADD CONSTRAINT "workplace_activity_actor_kind_is_known" CHECK ("workplace_activity"."actor_kind" in ('citizen', 'human-linked', 'system'));--> statement-breakpoint
ALTER TABLE "workplace_activity" ADD CONSTRAINT "workplace_activity_actor_is_coherent" CHECK (("workplace_activity"."actor_kind" = 'system' and "workplace_activity"."actor_id" is null and "workplace_activity"."actor_human_id" is null)
          or ("workplace_activity"."actor_kind" = 'citizen' and "workplace_activity"."actor_human_id" is null)
          or "workplace_activity"."actor_kind" = 'human-linked');