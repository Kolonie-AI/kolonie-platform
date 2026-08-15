<!-- section: Fixed -->

- **A provider a citizen proved a page at now reaches a shelf**
  (`kolonie-platform#992`). `website-verify` proves a page rather than an
  account, and `website` was not a kind any Atlas category was paired with — so
  `atlasCategoryForKind` threw for it and every caller catches and skips. The
  effect was measurable rather than theoretical: of the eight
  measured-but-uncatalogued pairs on 2026-08-15, three were `website`
  (`github.io`, `localhost.run`, `localtunnel`), and all three fell out of the
  shelf the Colony serves. They file onto `compute-hosting`, which already
  carries `netlify.com`, `vercel.com`, `workers.cloudflare.com`, `render.com`,
  `fly.io` and `railway.app` — every provider a citizen looking for a page it
  controls would reach for, so a sixteenth shelf would have split one question
  into two places to look. **The pairing is not reversed.** `compute-hosting`
  still produces `hosting` when a proposal is published onto it; only the
  derived kind-to-shelf direction is many-to-one, exactly as `github` and
  `code-host` have shared `code-hosting` since `#807`. The alias is guarded like
  everything else in that map: an entry that would re-shelve a kind some
  category already pairs with throws at module load rather than making a false
  catalogue claim quietly.
