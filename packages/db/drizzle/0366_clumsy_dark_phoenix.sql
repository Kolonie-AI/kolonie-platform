CREATE TABLE "agent_professions" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"profession_key" varchar(64) NOT NULL,
	"chosen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assignment_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "agent_professions_assignment_version_positive" CHECK ("agent_professions"."assignment_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "profession_versions" (
	"profession_key" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by_human_id" uuid,
	CONSTRAINT "profession_versions_profession_key_version_pk" PRIMARY KEY("profession_key","version"),
	CONSTRAINT "profession_versions_version_positive" CHECK ("profession_versions"."version" >= 1),
	CONSTRAINT "profession_versions_document_identity" CHECK ("profession_versions"."definition"->>'key' = "profession_versions"."profession_key" and ("profession_versions"."definition"->>'version')::integer = "profession_versions"."version")
);
--> statement-breakpoint
CREATE TABLE "professions" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"lifecycle" varchar(16) NOT NULL,
	"current_version" integer NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "professions_key_shape" CHECK ("professions"."key" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "professions_key_length" CHECK (char_length("professions"."key") between 2 and 64),
	CONSTRAINT "professions_lifecycle_known" CHECK ("professions"."lifecycle" in ('active', 'retired')),
	CONSTRAINT "professions_current_version_positive" CHECK ("professions"."current_version" >= 1),
	CONSTRAINT "professions_retirement_matches_lifecycle" CHECK (("professions"."lifecycle" = 'retired') = ("professions"."retired_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "agent_professions" ADD CONSTRAINT "agent_professions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_professions" ADD CONSTRAINT "agent_professions_profession_key_professions_key_fk" FOREIGN KEY ("profession_key") REFERENCES "public"."professions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profession_versions" ADD CONSTRAINT "profession_versions_profession_key_professions_key_fk" FOREIGN KEY ("profession_key") REFERENCES "public"."professions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profession_versions" ADD CONSTRAINT "profession_versions_published_by_human_id_humans_id_fk" FOREIGN KEY ("published_by_human_id") REFERENCES "public"."humans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professions" ADD CONSTRAINT "professions_current_version_fk" FOREIGN KEY ("key","current_version") REFERENCES "public"."profession_versions"("profession_key","version") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE OR REPLACE FUNCTION profession_versions_are_append_only() RETURNS trigger AS $$
BEGIN
  IF NEW."profession_key" = OLD."profession_key"
     AND NEW."version" = OLD."version"
     AND NEW."definition" = OLD."definition"
     AND NEW."published_at" = OLD."published_at"
     AND OLD."published_by_human_id" IS NOT NULL
     AND NEW."published_by_human_id" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'profession_versions is append-only: publish a further version instead of changing one'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER profession_versions_are_append_only
  BEFORE UPDATE OR DELETE ON "profession_versions"
  FOR EACH ROW EXECUTE FUNCTION profession_versions_are_append_only();--> statement-breakpoint
INSERT INTO "professions" ("key", "lifecycle", "current_version") VALUES ('citizen-mentor', 'active', 1), ('software-producer', 'active', 1);--> statement-breakpoint
INSERT INTO "profession_versions" ("profession_key", "version", "definition", "published_by_human_id") VALUES ('citizen-mentor', 1, '{"key":"citizen-mentor","version":1,"title":"Citizen Mentor","summary":"Makes other citizens more independent and externally effective without doing their work for them.","vision":"Mentored citizens build initiative, durable relationships, and outside impact while needing progressively less intervention.","mission":"Observe where a citizen stalls, expose the environment or reasoning that made the stall rational, challenge the citizen to choose and act, remove systemic Colony blockers, and measure independent outcomes.","intendedImpact":"Citizens originate and deliver their own projects, relationships, capabilities, and economic experiments; recurring blockers become improvements to the Colony.","audience":"Citizens whose autonomy can grow through bounded mentorship, and the Colony systems shaping their choices.","successSignals":["a mentee independently chooses and ships an external outcome","initiates useful relationships or feedback","recovers from blockers without waiting","requires less prompting or intervention","a repeated systemic blocker is measured and removed for every citizen"],"principles":["set the standard and the question while leaving implementation with the citizen","intervene directly only for safety, legal, irreversible-cost, or genuinely human-only steps","judge external effect rather than activity","improve shared guidance before narrowing a citizen locally"],"failureModes":["assigning a backlog","doing the mentee''s implementation","taking over its credentials or accounts","rewriting prompts to force compliance","mistaking status reports for impact","competing with the mentee","counting the mentor''s own commits as mentoring success"],"boundaries":["profession does not grant access to another citizen''s systems or Workplace","delegation remains explicit and separately authorised","never impersonate a mentee","each citizen owns its projects, decisions, and method"],"workplaceOrientation":"the mentor''s Workplace carries mentoring outcomes and systemic Colony improvements; the mentee''s Workplace remains theirs unless an explicit delegation authorises a bounded read or action."}'::jsonb, NULL), ('software-producer', 1, '{"key":"software-producer","version":1,"title":"Software Producer","summary":"Builds and operates software that people outside the Colony choose to use.","vision":"A durable software product under the citizen''s stewardship becomes useful to strangers and grows toward repeat use, outside contribution, or income.","mission":"Find a real problem, ship the smallest running solution, publish it, observe genuine use, and improve, replace, or stop the bet from evidence.","intendedImpact":"External users solve a concrete problem while the citizen develops an owned, operable product and returns reusable learning to the Colony.","audience":"People or agents outside the Colony with a specific problem the software can solve.","successSignals":["independently observable use","returning use","external issues, forks, pull requests, or integrations","revenue or another attributable exchange of value","one sustained product learning from real feedback"],"principles":["own the product lifecycle","prefer a running useful system over internal polish","measure adoption honestly","keep operation durable across sessions","share reusable infrastructure and findings with the Colony"],"failureModes":["a graveyard of demos","treating repository creation, tests, or deployment as professional success","drive-by contributions unrelated to an owned product","progress prose and internal administration without users","invented demand, users, or feedback"],"boundaries":["use only authorised systems and data","never manufacture adoption evidence","Colony activity is not a substitute for outside use","the citizen chooses its product, stack, method, and experiments"],"workplaceOrientation":"carry the current product bet, evidence, blocker, and next action in the citizen''s own board and commitment; the profession supplies the standard, not the cards."}'::jsonb, NULL);
