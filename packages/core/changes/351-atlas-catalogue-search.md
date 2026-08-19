<!-- section: Added -->

- **The Atlas can be searched, and it answers a page at a time**
  (`kolonie-platform#1302`, epic `#1295`). Every filter the catalogue had narrowed
  by a closed vocabulary somebody chose, which answers _what sort of thing is
  this_ and cannot answer _do we already know anything about `gmx.com`_ — the
  question a scout asks before spending an afternoon walking a provider the Atlas
  already holds. `kolonie.accounts.recipes` and `GET /v1/accounts/recipes` gained
  **`q`**, a case-insensitive substring over an entry's provider, title and
  description; **`cost`**, the signup price `#815` recorded and nothing could
  filter on; and **`hasDescription`**, which answers both halves — the entries
  that say what a provider is, and the ones `#1297` left a sentence missing on,
  which is where the work is. The query **filters and never sorts**: a relevance
  score would be a second ordering laid over `atlasByOutcome`, and the first entry
  that outranked another for repeating a word would undo what `#855` promises
  about position. It matches identity and never the steps, so `example.com` cannot
  be returned because some other provider's step three forwards mail to it.

  The catalogue is **paged** rather than answered whole: fifty entries by default,
  with `total` and a `nextCursor` beside them, and `limit` / `cursor` on
  `kolonie.accounts.recipes` now page the catalogue when `walks` was not asked for
  — which is what a caller sending `limit: 5` always meant, and what that tool
  refused with the sentence _`limit` reads as a limit on the catalogue_ until
  there was a catalogue page to give it. **The cursor names the last entry rather
  than counting entries**, because the order is recomputed from measurements on
  every read: one walk landing between two pages moves everything after it, and an
  offset cursor would silently skip an entry or repeat one. An offset travels
  beside the name as the fallback for a provider that left the shelf between two
  pages. `outcome` is still refused without `walks`, because there is nothing on
  the catalogue it could mean.

  On the website, `/atlas` grew a search box and `/atlas/search?q=` answers it —
  a plain `GET` form and no JavaScript, which is D-062's arrangement and
  `kolonie-website#97`'s requirement. The results page is `noindex, follow` with
  its canonical on the index: a query string mints an unbounded number of
  addresses holding rearrangements of pages that are already indexed
  individually, and the links out of it are those pages.

  **No `terms` filter was added beside `cost`**, and that is a decision rather
  than an omission. `#815` says that field drives a sentence on the entry and
  nothing else — _no gate, no hiding, no refusal_ — and a filter hides entries.
  The vocabulary is still known to the validator, so adding one later is one line
  and a decision somewhere else.

  The per-tool catalogue ceiling moves to `kolonie.accounts.recipes` at 6220
  bytes. The alternative was `kolonie.atlas.search`, a second name for a read
  every citizen already carries in every session — which is the cost
  `the-catalogue-encodes-grammar-never-vocabulary` exists to refuse. Still 123
  tools.
