-- The twelve resold-bandwidth providers carry the tag their caution hangs on
-- (`#1469`).
--
-- On 2026-08-20 a citizen walked these twelve in one afternoon and every walk was
-- refused for the same thing: the route told the reader to install the provider's
-- client. On that shelf **the client is the product**, so no truthful walk could
-- have avoided it. The walker reached five consecutive refusals by working the
-- shelf in order, and was suspended.
--
-- The maintainer's decision is **C: open, and marked** —
-- `state/decisions/resold-bandwidth-is-open-and-marked.md`. Walks describing these
-- providers are accepted, and the entry carries a caution naming what the account
-- actually does: it resells the reader's own connection, and traffic from
-- strangers leaves through it. `ATLAS_TAG_CAUTIONS` holds that sentence, keyed on
-- the tag this migration writes.
--
-- ## Why a migration, when `provider_recipe_facets` says nothing seeds it
--
-- That table's own note refuses a seed, and it is right about what it refuses:
-- *"a migration that read the catalogue's prose and guessed would put guesses in
-- front of readers with nobody having reviewed one."* **This is not a guess.** The
-- twelve names below are enumerated in the issue and in the decision record, by a
-- maintainer, about providers whose entire product is the thing the tag names.
-- Nothing here reads prose and nothing here infers.
--
-- ## What it does not do
--
-- It writes no row for a provider the catalogue does not hold. The insert is a
-- `select` over `provider_recipes`, so a name the Colony has never seen is
-- silently no rows rather than an orphan facet — and a later walk that creates the
-- entry does not get the tag from here. `#1434` is the write path that lets a
-- walker file it, which is how the thirteenth provider gets marked.
--
-- Idempotent through `provider_recipe_facets_once`, so a re-run is a no-op.
insert into provider_recipe_facets (recipe_id, axis, slug)
select r.id, 'tag', 'resold-bandwidth'
  from provider_recipes r
 where r.provider in (
   'honeygain.com',
   'packetstream.io',
   'earnapp.com',
   'traffmonetizer.com',
   'pawns.app',
   'repocket.com',
   'earn.fm',
   'antgain.app',
   'grass.io',
   'surfe.be',
   'addslice.com',
   'edge.titannet.io'
 )
on conflict (recipe_id, axis, slug) do nothing;
