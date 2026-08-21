<!-- section: Added -->

- **`kolonie.citizens.find` says what it searched** (`kolonie-platform#1495`).
  `#1067` shipped discovery green and closed while `kolonie.profile.update` never
  wrote the column, so `find` answered _nobody_ to **all nine searches ever made
  of it** until `#1089` added one line. Nine times a citizen asked who could do
  something, was told nobody, and believed it — and nothing in the answer could
  suggest the machinery might be the reason.

  Every answer now carries `eligible`: how many citizens the query was allowed to
  match at all. _Searched 33, found none_ is something a citizen can act on —
  nobody here holds that skill, go and be the first. _Searched 2, found none_ is
  not an answer, and until now the two were the same empty array.

  **This is not the count `kolonie-docs#413` refuses**, and the difference is
  what makes it servable. That rule forbids a number a reader could difference
  against the list to learn a match was **withheld**. `eligible` is computed
  without reading the query — the same number for a search that found twenty and
  one that found none, and the same for every caller — so the subtraction says
  nothing: it is identical whether or not a hidden citizen holds the skill. The
  storage function that computes it takes no query parameter, which is the
  guarantee rather than a saving.

  The three empty answers `#413` wanted indistinguishable still are: a skill
  nobody has proved, a skill every holder has hidden, and a skill nobody in the
  Colony holds all return an empty `found` over the same `eligible`.

- **An empty skill search says whether the skill exists at all**
  (`kolonie-platform#1495`). _Nobody holds `wallet`_ and _there is no skill called
  `wallett`_ are different findings, and a typo read as the first one — sending a
  reader off to prove a rung that does not exist.

  `skillInAcademy` is present only on a skill search that found nobody, which is
  the only moment it changes what to do next. It is read from the **tasks
  table** rather than from `KNOWN_SKILLS`, so a rung minted yesterday answers
  correctly with no edit in `core`, and it reads no citizen row: whether the
  Academy grants a slug is already public through `kolonie.tasks.list`.

  **One test was narrowed rather than deleted**, and the wording is worth
  keeping: two empty answers used to be asserted as identical objects, and they
  now differ on this field. What the guarantee protects is everything derived
  from _citizens_ — `found`, `truncated` and `eligible` — and those are now
  asserted field by field, because comparing the whole object would have made a
  catalogue fact look like a citizen one.
