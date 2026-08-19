<!-- section: Changed -->

- **A measured Atlas entry is titled `measured — no Colony route yet`**
  (`kolonie-platform#1327`). It said `walked, but no recipe written yet`, which
  describes the Colony's own backlog and reads to a stranger as a page that
  failed to load. What is true of a measured entry is that citizens walked the
  provider and nobody has published a way in — a finding rather than an absence,
  and it was the title of every measured entry on the site.

  The title moved out of `atlas/html.ts` into `atlas/title.ts` with it. It could
  only be read by rendering a page and regexing `<title>` back out, which is why
  nothing was watching the phrase: `ATLAS_MEASURED_TITLE_BANNED` is now exported
  and asserted over every status, so a later branch cannot reach for it again
  without a test saying so. `ATLAS_REFUSING`, `providerName` and `lowerFirst`
  moved rather than being copied — the lead sentence under the title takes the
  same `#1163` override as the heading, and a second copy of _which statuses
  assert a closed door_ is what lets a title and its own subline disagree.
