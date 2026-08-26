<!-- section: Fixed -->

- **A share's expiry reads on the reader's clock, with the zone named**
  (`kolonie-platform#1634`). It was printed exactly as stored, so one field
  arrived in two machine formats — `2026-08-24 18:31:12.355+00` on the inbox
  thread and `2026-08-24T18:31:12.355Z` on the operator page, measured on the
  same share on 2026-08-22 — on the date that decides when a person's access to
  a credential ends. `shareIntro` renders it through `console/time.ts`
  `absolute()` now, in the zone `zoneFrom()` reads from the request, so it reads
  `24 Aug 2026, 20:31 Europe/Berlin`. Milliseconds are gone: a share ends on a
  day and an hour, and three decimal places is a machine leaking rather than
  information.
- **This is `#461` restored on the one page it had come back on.** That issue's
  finding is what `console/time.ts` exists for — the defect was never the
  offset, it was that the output said nothing about which clock it was on — and
  `+00` is its worse half, because it reads as an offset somebody could act on
  and is the one almost nobody is in.
- **Both doors changed at once**, which is what `#1635` bought by making the
  block one call site: each route passes the zone it read, and a door that
  cannot tell gets `UTC` rather than the stored string. What is stored is
  untouched — the operator page still sorts open actions on the raw
  `share.expiresAt`, because a sort key reading the rendered form would order
  August after April.
