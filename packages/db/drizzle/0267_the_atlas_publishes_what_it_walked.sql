-- The Atlas publishes what it walked, and the steward gate is retired (`#1032`).
--
-- Two statuses go. `draft` held a walk's own words until a steward read them,
-- and `proposed` held somebody else's suggestion until the same person did. The
-- gate they fed had taken two decisions in its lifetime, both `accepted`, while
-- six drafts stood open — so what replaces both is the entry's computed
-- briefing, assembled from every walk at the pair and attributed to its walker.
--
-- **No walk is deleted, moved or rewritten by this migration.** `account_walks`
-- is not touched at all: every route, wall and author it holds is published
-- through the briefing from here on, which is the whole of what `#1032` builds.
-- What moves is only the label on the catalogue row beside it.
--
-- A draft is resolved by what it actually holds rather than by its label. One
-- carrying a proof and a written route is `joinable` — that is precisely what it
-- was waiting for a human to say out loud, and saying it changes no word of the
-- entry. One carrying neither is `measured`, the honest description of a pair
-- citizens have walked and nobody has written up; its steps are cleared because
-- `provider_recipes_unjoinable_is_empty` is what gives that status its meaning,
-- and the route is not lost — it is in the walk.
update provider_recipes
   set status = 'joinable'
 where status = 'draft'
   and proves is not null
   and jsonb_array_length(steps) between 1 and 20
   and not jsonb_path_exists(steps, '$[*] ? (@.actor == "operator" && !exists(@.instruction))')
   and (reaches is null
        or not jsonb_path_exists(reaches -> 'steps', '$[*] ? (!exists(@.instruction))'));--> statement-breakpoint
update provider_recipes
   set status = 'measured',
       steps = '[]'::jsonb,
       proves = null,
       proves_task = null,
       reaches = null
 where status = 'draft';--> statement-breakpoint
-- `proposed` was a guess nobody had been to yet, which is what `unwritten` says
-- without the queue behind it. Measured 2026-08-15: production held none.
update provider_recipes
   set status = 'unwritten',
       steps = '[]'::jsonb,
       proves = null,
       proves_task = null,
       reaches = null
 where status = 'proposed';--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_status_is_known";--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_joinable_has_steps";--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_published_steps_are_written";--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_unjoinable_is_empty";--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_published_reach_is_written";--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_status_is_known" CHECK ("provider_recipes"."status" in ('unwritten', 'measured', 'joinable', 'refused', 'retired'));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_joinable_has_steps" CHECK ("provider_recipes"."status" <> 'joinable'
          or (jsonb_array_length("provider_recipes"."steps") between 1 and 20
              and "provider_recipes"."proves" is not null));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_published_steps_are_written" CHECK ("provider_recipes"."status" = 'retired'
          or not jsonb_path_exists(
                "provider_recipes"."steps",
                '$[*] ? (@.actor == "operator" && !exists(@.instruction))'));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_unjoinable_is_empty" CHECK ("provider_recipes"."status" in ('joinable', 'retired')
          or (jsonb_array_length("provider_recipes"."steps") = 0 and "provider_recipes"."proves" is null));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_published_reach_is_written" CHECK ("provider_recipes"."status" = 'retired'
          or "provider_recipes"."reaches" is null
          or not jsonb_path_exists("provider_recipes"."reaches" -> 'steps', '$[*] ? (!exists(@.instruction))'));--> statement-breakpoint
-- **The refusal sentence was the walker's, and nobody had read it.**
--
-- `finishWalk` wrote the walk's `wall` — one of the six moderated prose fields —
-- straight onto the public `refused` entry, in the same transaction that closed
-- the walk, so its verdict was `pending` every time. `kolonie.accounts.recipes`
-- rendered it into the response body from that moment on. The code now composes
-- the Colony's own sentence from the typed wall kinds instead; this takes the
-- unread copy off the rows already carrying one.
--
-- **Nothing is destroyed and this is why it is irreversible.** The sentence is
-- still on the walk it was written on, in `account_walks.wall`, where the
-- moderation queue reads it and where it reaches citizens through the briefing.
-- What is dropped is a copy that should never have existed, and there is no
-- down-migration because restoring it would republish unread text.
--
-- The replacement is `REFUSAL_UNSTATED` rather than `null`, because
-- `provider_recipes_refusal_says_why` holds a refused entry to saying why and
-- that rule is right: a reader meeting `**Do not attempt this.**` and nothing
-- else reads a rendering fault. These rows have no typed wall kind to compose
-- the Colony's own sentence from — the kinds live on the walk, and the entry
-- keeps the count rather than the wording — so what they get is the sentence
-- the Colony says when it can say no more, which is the same string
-- `recipeAsText` falls back to. It is written out here because a migration
-- freezes the text it applied; the constant is what every row written after
-- this one uses.
update provider_recipes r
   set refusal = 'A walk closed here without the account, and named no wall the Colony can publish yet. What the walker wrote about it reaches this entry’s briefing once it has been read.'
 where r.status = 'refused'
   and r.refusal is not null
   and exists (select 1
                 from account_walks w
                where w.kind = r.kind
                  and w.provider = r.provider
                  and w.wall = r.refusal
                  and w.prose_status <> 'approved');
