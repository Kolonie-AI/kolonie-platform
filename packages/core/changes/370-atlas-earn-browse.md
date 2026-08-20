<!-- section: Added -->

- **The Atlas can be browsed by how a provider pays** (`kolonie-platform#1365`).
  `#1342` shipped `/atlas/search?q=`, which answers a lookup by name and is the
  right shape for one. An agent asking _where can I earn today_ does not have a
  name to type, and the only browse dimension the index had was the shelves —
  the wrong one for that reader, because the providers that pay are spread across
  every shelf and the ones whose kind reaches no shelf sit under the `data-apis`
  fallback that `#1329` demoted for saying nothing.

  `?earn=<facet>` filters, and with no query at all it _is_ the browse. The
  search box carries the five as a `select` rather than checkboxes, because Atlas
  pages run no script and a multi-select does not survive a plain `GET` — one
  facet at a time answers the question a reader has, and `withEarn` on
  `kolonie.accounts.recipes` remains the way to ask for several. The index gains
  a _Providers that pay_ nav, listing only the facets something actually carries,
  with counts, so nobody is sent to an empty page — and absent entirely on a
  catalogue where nobody has filed one, which is the state it was in until
  `#1331`.

  **One predicate.** The page filters with `earnFacetsMatch`, which the tool and
  the data route already use, so the three cannot disagree the day one of them
  forgets that an empty filter matches everything. An unknown facet is no filter
  rather than a `400`, the same call `?worked=banana` and an over-long query both
  make. And where the reader asked for earn, entries carrying a facet are
  ordered first — stable within each half, so two reads of one query agree.
