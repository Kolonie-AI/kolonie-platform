<!-- section: Changed -->

- **The Atlas says when it has not classified something, instead of saying
  nothing** (`kolonie-platform#1407`). `#1096` files a kind that matches no shelf
  under the `data-apis` fallback rather than dropping the entry, and `#1329`
  stopped the _entry_ page presenting that shelf as the provider's identity. What
  was left was silence — and on an entry carrying an earn facet, silence reads as
  _classified_ rather than as _nobody has classified this_. Two sentences close
  that. **The fallback shelf's own page now says it is a queue**, which is the
  surface that read worst: a heading and a standfirst over forty rows is the
  strongest form the site has of _these things belong together_, and `#1329` had
  left it alone. **And a fallback-shelved entry says so on its own page**,
  including the earn-carrying ones — those are the entries `#1407` was filed
  about.
- **`atlasShelfClause` is untouched and stays silent on an earn-carrying entry.**
  It is a _header_ clause stating what the provider is, and `#1329`'s reasoning
  holds: a reader who has just been told _this pays for finished tasks_ has been
  classified, and adding _nobody has filed it on a shelf_ would spend a line on
  the Colony's bookkeeping. `atlasUncategorisedNote` is a different thing in a
  different place — the route to close the gap, addressed to somebody who could
  close it. Folding the two would put both issues' reasoning in one condition.
- **The proposal object and its accept path are documented in D-136**, which is
  `#1407`'s first acceptance criterion and turns out to be a documentation job
  rather than a build: `#1106` shipped the whole pipeline. A discriminated union
  in which _a new top category_ is not a value the type can hold, evidence that
  cannot be empty, a closed vocabulary of targets, one transactional accept, and
  sixteen state-machine tests. **Nothing auto-renames a shelf**, because nothing
  but `decideAtlasCategoryProposal` writes to `atlas_categories`.
- **The dry-run `#1407` asked for is a measurement rather than a proposal, and
  the premise it tested does not hold.** Against production 2026-08-23:
  `provider_recipe_facets` holds **115 tag rows and no earn row at all**, and
  every one of the **nine** entries on `data-apis` is `kind = 'api'` —
  `anthropic.com`, `alphavantage.co`, `platform.openai.com` and six more, filed
  on the shelf named after exactly what they are. It is the sixth largest shelf;
  `telephony` holds 36. **There is no earn corpus to propose from and no junk
  drawer to clear**, so what ships is the guard that keeps the shelf from reading
  as a classification when something does fall into it, rather than a repair of
  something currently broken. D-136 carries both queries so the next reader can
  re-take the measurement.
