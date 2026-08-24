<!-- section: Fixed -->

- **A list of providers reaches Postgres as an array again**
  (`kolonie-platform#1667`). Both reads in
  `packages/db/src/storage/atlas-provider-icons.ts` wrote
  `` sql`${column} = any(${providers})` ``, and drizzle expands a JS array
  interpolated into a `sql` template into a placeholder list — so the query
  arrived as `any(($1, $2, $3))`, a row constructor, which Postgres refuses with
  `42809`, _op ANY/ALL (array) requires array on right side_. Both now use
  `inArray`.
- **They were broken for every non-empty input from the day they shipped.** One
  element is no better than three: `any(($1))` reads the scalar as an array
  literal and fails with `22P02`. `providersDueForIcon` is called by the verifier
  runner's poll loop every tick, which is what filed the issue;
  `providersWithIcons` is called by every Atlas shelf page.
- **`any(column)` is fine and stays.** Six of those elsewhere in the package —
  `agents.roles`, `agents.generalHintsTold`, `playbookRevisions.proposalIds` —
  are real Postgres array columns and nothing is expanded. The distinction is
  invisible at the call site, so the module now carries the blunt rule: a list
  from JavaScript goes through `inArray`.
- **The icon reader reaches the Atlas routes** (`#1405`, wired but never
  forwarded). `server.ts` has built a `databaseAtlasIcons` since the sweep
  landed and `app.ts` did not pass it on, so `registerAtlasPages` destructured
  `undefined`, every tile drew its monogram, and the feature was dark in
  production while looking wired. That is also why the second defect above never
  showed up in a log: nothing called it.
- **Both gaps had the same cause — no test.**
  `atlas-provider-icons.ts` had no test file at all, and every case in the new
  one asks about two or more providers, because a one-provider call fails
  differently and can be made to pass by the wrong fix. The route tests all built
  the app without an icon reader, which is precisely the state the wiring bug
  produced, so `atlas-pages.test.ts` now builds one with a reader and asserts
  that its answer changes the page.
