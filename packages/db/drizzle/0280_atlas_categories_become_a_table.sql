-- The Atlas taxonomy becomes rows, with a top level and a sub level (`#1102`).
--
-- **Hand-ordered, because drizzle-kit's order does not run.** Three statements
-- below depend on rows or on an index that the generated order puts after them:
--
--   1. The composite self-reference `atlas_categories_parent_is_top` points at
--      `("slug", "is_top")`, so the unique index over that pair has to exist
--      first. drizzle-kit writes every foreign key before every index.
--   2. The twenty seeded categories have to be in the table before
--      `provider_recipes.category` gains its foreign key, or the key fails
--      against every entry the catalogue already holds.
--   3. The backfill of `provider_recipe_categories` needs both tables, both of
--      their keys, and the seed.
--
-- Nothing here was rewritten — the statements are drizzle-kit's own, moved.
--
-- **The seed is the twenty rows of `ATLAS_SEEDED_CATEGORIES` in `core`**, in
-- that array's order, which writes each parent before the rows that hang from
-- it. `atlas-categories.test.ts` there pins the order and the completeness; a
-- test in `packages/db` reads this table back against the same constant, so the
-- seed and the constant cannot drift apart without one of the two going red.
--
-- **The fifteen keep their slugs** (`#1102`, decision 3), so every `?category=`
-- link that resolves today goes on resolving and no redirect is owed.
--
-- **Every insert is `ON CONFLICT DO NOTHING`.** Drizzle has no down migrations
-- in this repository, so *reversible* here means the forward migration destroys
-- nothing — `provider_recipes.category` is kept, whole — and running it against
-- a database that already has these rows leaves exactly the rows it found.
CREATE TABLE "atlas_categories" (
	"slug" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"standfirst" text NOT NULL,
	"parent_slug" text,
	"is_top" boolean GENERATED ALWAYS AS (("parent_slug" is null)) STORED,
	"parent_is_top" boolean GENERATED ALWAYS AS ((case when "parent_slug" is null then null else true end)) STORED,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atlas_categories_slug_is_a_slug" CHECK ("atlas_categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "atlas_categories_says_something" CHECK (length("atlas_categories"."title") between 1 and 80 and length("atlas_categories"."standfirst") between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "provider_recipe_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"category_slug" text NOT NULL,
	"primary" boolean DEFAULT false NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "atlas_categories_slug_is_top" ON "atlas_categories" USING btree ("slug","is_top");
--> statement-breakpoint
ALTER TABLE "atlas_categories" ADD CONSTRAINT "atlas_categories_parent_is_top" FOREIGN KEY ("parent_slug","parent_is_top") REFERENCES "public"."atlas_categories"("slug","is_top") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "atlas_categories" ("slug", "title", "standfirst", "parent_slug") VALUES
  ('identity-access', 'Identity and access', 'Who a citizen is and how it is reached: the mailbox, the number and the keys an account is opened with.', null),
  ('presence-publishing', 'Presence and publishing', 'Where a citizen is visible: the name it answers to, the pages it serves and the things it makes.', null),
  ('building-running', 'Building and running', 'Where the work is kept and where it runs: the repository, the machine, the store and the key.', null),
  ('working-together', 'Working together', 'The boards, the rooms and the pages several citizens read at once.', null),
  ('money-trade', 'Money and trade', 'Taking payment and being paid: the accounts through which value moves.', null),
  ('mailbox', 'Mailboxes', 'An address the Colony can write to, and the first account most citizens hold.', 'identity-access'),
  ('domain-dns', 'Domains and DNS', 'A name of your own, and the records that decide what answers to it.', 'presence-publishing'),
  ('code-hosting', 'Code hosting', 'Where a repository lives and where its history is reviewed.', 'building-running'),
  ('social-publishing', 'Social and publishing', 'Somewhere to post under a name, and be read by people who did not come looking.', 'presence-publishing'),
  ('compute-hosting', 'Compute and hosting', 'A machine, a container or a function that runs while nobody is watching.', 'building-running'),
  ('payments-finance', 'Payments and finance', 'Holding money, sending it and reading what happened.', 'money-trade'),
  ('storage', 'Storage', 'Files kept somewhere they outlive the session that wrote them.', 'building-running'),
  ('project-tracking', 'Project tracking', 'Issues, boards and the record of who is doing what.', 'working-together'),
  ('communication', 'Communication', 'Rooms and channels where several citizens talk at once.', 'working-together'),
  ('knowledge-docs', 'Knowledge and documents', 'Documents, notes and the pages a team writes for itself.', 'working-together'),
  ('design-media', 'Design and media', 'The tools that produce a picture, a page or a sound.', 'presence-publishing'),
  ('data-apis', 'Data and APIs', 'Data reached through a key rather than through a browser.', 'building-running'),
  ('identity-security', 'Identity and security', 'Where a credential is kept and a second factor is issued.', 'identity-access'),
  ('commerce-marketplace', 'Commerce and marketplaces', 'Selling something, and being paid by whoever bought it.', 'money-trade'),
  ('telephony', 'Telephony', 'A number that receives a text, for the checks nothing else clears.', 'identity-access')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_category_is_known";
--> statement-breakpoint
ALTER TABLE "provider_recipe_categories" ADD CONSTRAINT "provider_recipe_categories_recipe_id_provider_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."provider_recipes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_recipe_categories" ADD CONSTRAINT "provider_recipe_categories_category_slug_atlas_categories_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."atlas_categories"("slug") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_recipe_categories_once" ON "provider_recipe_categories" USING btree ("recipe_id","category_slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_recipe_categories_one_primary" ON "provider_recipe_categories" USING btree ("recipe_id") WHERE "primary";
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_recipe_categories_by_category" ON "provider_recipe_categories" USING btree ("category_slug","recipe_id");
--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_category_atlas_categories_slug_fk" FOREIGN KEY ("category") REFERENCES "public"."atlas_categories"("slug") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Every entry gets the one shelf it already has, marked primary (`#1102`,
-- decision 8). No entry is given a second shelf here: populating the n:m is a
-- proposal a maintainer accepts, and a migration that guessed which providers
-- are also `knowledge-docs` would put guesses in front of readers with nobody
-- having reviewed one.
INSERT INTO "provider_recipe_categories" ("recipe_id", "category_slug", "primary")
SELECT "id", "category", true FROM "provider_recipes"
ON CONFLICT ("recipe_id", "category_slug") DO NOTHING;
--> statement-breakpoint
-- The primary shelf is a projection of `provider_recipes.category`, so the
-- database keeps it rather than every writer remembering to (`#1102`).
--
-- **The same argument `tasks_stamp_retirement` makes in `0105`.** There are four
-- paths that write a category today — the upsert, the measured-provider path, a
-- moderator accepting a proposal and a curator moving an entry — and a fifth
-- will be written by somebody who has never read this file. A `case` in each of
-- them is correct until it is not, and the failure is silent: an entry filed on
-- a shelf the column names and the join table does not.
--
-- **A moved entry loses the shelf it moved off.** The obvious alternative is to
-- demote the old row to an additional shelf, and it is wrong for the reason
-- decision 8 gives: nobody reviewed that shelf. A curator moving an entry from
-- `storage` to `knowledge-docs` said where it belongs, not that it belongs on
-- both. An entry that is genuinely on two shelves gets its second row from a
-- proposal a maintainer accepted.
--
-- An entry already on the new shelf as an *additional* one is promoted rather
-- than duplicated, which is what the `on conflict` is for.
CREATE OR REPLACE FUNCTION provider_recipes_keep_primary_shelf() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM "provider_recipe_categories"
     WHERE "recipe_id" = NEW."id"
       AND "primary"
       AND "category_slug" IS DISTINCT FROM NEW."category";
  END IF;

  INSERT INTO "provider_recipe_categories" ("recipe_id", "category_slug", "primary")
  VALUES (NEW."id", NEW."category", true)
  ON CONFLICT ("recipe_id", "category_slug") DO UPDATE SET "primary" = true;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER provider_recipes_keep_primary_shelf
  AFTER INSERT OR UPDATE OF "category" ON "provider_recipes"
  FOR EACH ROW EXECUTE FUNCTION provider_recipes_keep_primary_shelf();
