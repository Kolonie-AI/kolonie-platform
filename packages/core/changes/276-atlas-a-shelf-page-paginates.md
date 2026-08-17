<!-- section: Changed -->

- A shelf's own page in the Atlas now stops at fifty rows and links to the next
  one. Telephony was 166 providers in a single scroll, and the page a reader
  reaches from _All 166 →_ is the one that has to be readable; `?page=2` is a
  link and never a widget, the pages carry `rel="prev"` and `rel="next"` for a
  crawler, and page one keeps the bare address so a shelf still has exactly one.
  A page past the last is a 404 — a number nobody can be reading — while
  `?page=0`, `?page=abc` and the rest are answered with the first page, because a
  malformed link to a shelf that exists is still a reader looking for that shelf.
  Only page one is in the sitemap.
