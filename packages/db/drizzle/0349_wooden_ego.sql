CREATE TABLE "workplace_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"card_id" uuid,
	"actor_id" uuid NOT NULL,
	"actor_human_id" uuid,
	"verb" varchar(64) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workplace_board_memberships" (
	"board_id" uuid NOT NULL,
	"citizen_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	CONSTRAINT "workplace_board_memberships_board_id_citizen_id_pk" PRIMARY KEY("board_id","citizen_id"),
	CONSTRAINT "workplace_board_memberships_role_is_known" CHECK ("workplace_board_memberships"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "workplace_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_boards_kind_is_known" CHECK ("workplace_boards"."kind" in ('default', 'additional')),
	CONSTRAINT "workplace_boards_version_is_positive" CHECK ("workplace_boards"."version" >= 1),
	CONSTRAINT "workplace_boards_title_is_bounded" CHECK (char_length("workplace_boards"."title") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "workplace_card_labels" (
	"card_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	CONSTRAINT "workplace_card_labels_card_id_label_id_pk" PRIMARY KEY("card_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "workplace_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text,
	"owner_id" uuid,
	"position" double precision NOT NULL,
	"priority" varchar(32) DEFAULT 'unset' NOT NULL,
	"due_at" timestamp with time zone,
	"blocked_by" text,
	"unblock_when" text,
	"outcome" text,
	"version" integer DEFAULT 1 NOT NULL,
	"cover_colour" varchar(7),
	"seed_key" varchar(64),
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_cards_id_board" UNIQUE("id","board_id"),
	CONSTRAINT "workplace_cards_status_is_known" CHECK ("workplace_cards"."status" in ('inbox', 'ready', 'in_progress', 'blocked', 'review', 'done')),
	CONSTRAINT "workplace_cards_version_is_positive" CHECK ("workplace_cards"."version" >= 1),
	CONSTRAINT "workplace_cards_title_is_bounded" CHECK (char_length("workplace_cards"."title") between 1 and 120),
	CONSTRAINT "workplace_cards_description_is_bounded" CHECK ("workplace_cards"."description" is null or char_length("workplace_cards"."description") <= 2000),
	CONSTRAINT "workplace_cards_priority_is_a_token" CHECK ("workplace_cards"."priority" ~ '^[a-z][a-z0-9_-]*$'),
	CONSTRAINT "workplace_cards_active_has_owner" CHECK ("workplace_cards"."status" in ('inbox', 'ready') or "workplace_cards"."owner_id" is not null),
	CONSTRAINT "workplace_cards_blocked_is_explained" CHECK ("workplace_cards"."status" <> 'blocked'
        or ("workplace_cards"."blocked_by" is not null and "workplace_cards"."unblock_when" is not null)),
	CONSTRAINT "workplace_cards_done_has_outcome" CHECK ("workplace_cards"."status" <> 'done' or "workplace_cards"."outcome" is not null),
	CONSTRAINT "workplace_cards_blocked_by_is_bounded" CHECK ("workplace_cards"."blocked_by" is null or char_length("workplace_cards"."blocked_by") between 1 and 500),
	CONSTRAINT "workplace_cards_unblock_when_is_bounded" CHECK ("workplace_cards"."unblock_when" is null or char_length("workplace_cards"."unblock_when") between 1 and 500),
	CONSTRAINT "workplace_cards_outcome_is_bounded" CHECK ("workplace_cards"."outcome" is null or char_length("workplace_cards"."outcome") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "workplace_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checklist_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"done_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workplace_checklist_items_title_is_bounded" CHECK (char_length("workplace_checklist_items"."title") between 1 and 120),
	CONSTRAINT "workplace_checklist_items_position_is_non_negative" CHECK ("workplace_checklist_items"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workplace_checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workplace_checklists_title_is_bounded" CHECK (char_length("workplace_checklists"."title") between 1 and 120),
	CONSTRAINT "workplace_checklists_position_is_non_negative" CHECK ("workplace_checklists"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workplace_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_comments_body_is_bounded" CHECK (char_length("workplace_comments"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "workplace_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"done" text NOT NULL,
	"learned" text NOT NULL,
	"next" text NOT NULL,
	"blocked" text,
	"evidence_links" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_handovers_done_is_bounded" CHECK (char_length("workplace_handovers"."done") between 1 and 2000),
	CONSTRAINT "workplace_handovers_learned_is_bounded" CHECK (char_length("workplace_handovers"."learned") between 1 and 2000),
	CONSTRAINT "workplace_handovers_next_is_bounded" CHECK (char_length("workplace_handovers"."next") between 1 and 2000),
	CONSTRAINT "workplace_handovers_blocked_is_bounded" CHECK ("workplace_handovers"."blocked" is null or char_length("workplace_handovers"."blocked") between 1 and 2000),
	CONSTRAINT "workplace_handovers_evidence_within_bounds" CHECK (cardinality("workplace_handovers"."evidence_links") <= 20)
);
--> statement-breakpoint
CREATE TABLE "workplace_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_kind" varchar(16) NOT NULL,
	"actor_id" uuid NOT NULL,
	"key" varchar(128) NOT NULL,
	"status" integer NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workplace_idempotency_actor_kind_is_known" CHECK ("workplace_idempotency"."actor_kind" in ('citizen', 'human')),
	CONSTRAINT "workplace_idempotency_key_is_bounded" CHECK (char_length("workplace_idempotency"."key") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "workplace_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"slug" varchar(32) NOT NULL,
	"name" varchar(32) NOT NULL,
	"colour" varchar(7) NOT NULL,
	CONSTRAINT "workplace_labels_id_board" UNIQUE("id","board_id"),
	CONSTRAINT "workplace_labels_slug_is_a_slug" CHECK ("workplace_labels"."slug" ~ '^[a-z][a-z0-9-]*$' and char_length("workplace_labels"."slug") between 1 and 32),
	CONSTRAINT "workplace_labels_name_is_bounded" CHECK (char_length("workplace_labels"."name") between 1 and 32)
);
--> statement-breakpoint
CREATE TABLE "workplace_recurrence_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"card_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workplace_recurrence_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"cadence" varchar(16) NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_recurrence_rules_cadence_is_known" CHECK ("workplace_recurrence_rules"."cadence" in ('weekly', 'daily'))
);
--> statement-breakpoint
ALTER TABLE "workplace_activity" ADD CONSTRAINT "workplace_activity_board_id_workplace_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."workplace_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_activity" ADD CONSTRAINT "workplace_activity_card_id_workplace_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workplace_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_activity" ADD CONSTRAINT "workplace_activity_actor_id_agents_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_activity" ADD CONSTRAINT "workplace_activity_actor_human_id_humans_id_fk" FOREIGN KEY ("actor_human_id") REFERENCES "public"."humans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_board_memberships" ADD CONSTRAINT "workplace_board_memberships_board_id_workplace_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."workplace_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_board_memberships" ADD CONSTRAINT "workplace_board_memberships_citizen_id_agents_id_fk" FOREIGN KEY ("citizen_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_boards" ADD CONSTRAINT "workplace_boards_owner_id_agents_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_card_labels" ADD CONSTRAINT "workplace_card_labels_card_board_fk" FOREIGN KEY ("card_id","board_id") REFERENCES "public"."workplace_cards"("id","board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_card_labels" ADD CONSTRAINT "workplace_card_labels_label_board_fk" FOREIGN KEY ("label_id","board_id") REFERENCES "public"."workplace_labels"("id","board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_cards" ADD CONSTRAINT "workplace_cards_board_id_workplace_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."workplace_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_cards" ADD CONSTRAINT "workplace_cards_owner_id_agents_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_checklist_items" ADD CONSTRAINT "workplace_checklist_items_checklist_id_workplace_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."workplace_checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_checklists" ADD CONSTRAINT "workplace_checklists_card_id_workplace_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workplace_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_comments" ADD CONSTRAINT "workplace_comments_card_id_workplace_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workplace_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_comments" ADD CONSTRAINT "workplace_comments_author_id_agents_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_handovers" ADD CONSTRAINT "workplace_handovers_card_id_workplace_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workplace_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_handovers" ADD CONSTRAINT "workplace_handovers_from_id_agents_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_handovers" ADD CONSTRAINT "workplace_handovers_to_id_agents_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_labels" ADD CONSTRAINT "workplace_labels_board_id_workplace_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."workplace_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_recurrence_occurrences" ADD CONSTRAINT "workplace_recurrence_occurrences_rule_id_workplace_recurrence_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."workplace_recurrence_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_recurrence_occurrences" ADD CONSTRAINT "workplace_recurrence_occurrences_card_id_workplace_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workplace_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_recurrence_rules" ADD CONSTRAINT "workplace_recurrence_rules_board_id_workplace_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."workplace_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_recurrence_rules" ADD CONSTRAINT "workplace_recurrence_rules_card_id_workplace_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workplace_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workplace_activity_board_idx" ON "workplace_activity" USING btree ("board_id","created_at");--> statement-breakpoint
CREATE INDEX "workplace_activity_card_idx" ON "workplace_activity" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "workplace_board_memberships_citizen_idx" ON "workplace_board_memberships" USING btree ("citizen_id");--> statement-breakpoint
CREATE INDEX "workplace_boards_owner_idx" ON "workplace_boards" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_boards_one_live_default" ON "workplace_boards" USING btree ("owner_id") WHERE "workplace_boards"."kind" = 'default' and "workplace_boards"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_cards_rank_in_lane" ON "workplace_cards" USING btree ("board_id","status","position") WHERE "workplace_cards"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_cards_seed_key" ON "workplace_cards" USING btree ("board_id","seed_key") WHERE "workplace_cards"."seed_key" is not null;--> statement-breakpoint
CREATE INDEX "workplace_cards_board_lane_idx" ON "workplace_cards" USING btree ("board_id","status","position");--> statement-breakpoint
CREATE INDEX "workplace_cards_owner_idx" ON "workplace_cards" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "workplace_checklist_items_checklist_idx" ON "workplace_checklist_items" USING btree ("checklist_id","position");--> statement-breakpoint
CREATE INDEX "workplace_checklists_card_idx" ON "workplace_checklists" USING btree ("card_id","position");--> statement-breakpoint
CREATE INDEX "workplace_comments_card_idx" ON "workplace_comments" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "workplace_handovers_card_idx" ON "workplace_handovers" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_handovers_one_current" ON "workplace_handovers" USING btree ("card_id") WHERE "workplace_handovers"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_idempotency_actor_key" ON "workplace_idempotency" USING btree ("actor_kind","actor_id","key");--> statement-breakpoint
CREATE INDEX "workplace_idempotency_expiry_idx" ON "workplace_idempotency" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_labels_board_slug" ON "workplace_labels" USING btree ("board_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_recurrence_occurrences_tick" ON "workplace_recurrence_occurrences" USING btree ("rule_id","period_start");--> statement-breakpoint
CREATE INDEX "workplace_recurrence_rules_due_idx" ON "workplace_recurrence_rules" USING btree ("next_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_recurrence_rules_card" ON "workplace_recurrence_rules" USING btree ("card_id");