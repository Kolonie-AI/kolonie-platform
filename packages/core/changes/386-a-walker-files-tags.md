<!-- section: Added -->

- **A walker can put tags on a provider's Atlas entry**
  (`kolonie-platform#1434`, `#1406` decision 3). `kolonie.accounts.walk-report`
  and `kolonie.accounts.provider-report` take `tags`, up to `RECIPE_MAX_TAGS`,
  each checked against `AtlasTagSlugSchema`. `#1406` shipped the schema, the read
  path, the chips and the `?tag=` search; the write path did not, so nothing could
  put a tag on an entry except a hand-written `insert`.

  **Moderation: held.** A slug cannot carry a credential, so there is nothing to
  scrub — but it can carry a grudge, and `#981` section 4 already draws that line:
  a kind, a count, a boolean and a number publish unmoderated because none of them
  can, and everything that can waits for the verdict every other sentence in the
  Atlas waits for. So a filed tag rides on the walk in `account_walks.filed_tags`
  and reaches `provider_recipe_facets` when that walk's prose is approved. A
  refused walk publishes none, and a repeat publishes none either — nothing read
  its page.

  **The union and never the replacement.** `addRecipeTags` adds what is missing,
  so a walker who knows nothing about four other walkers' tags cannot withdraw
  them, and re-filing one the entry already carries writes nothing rather than
  erroring. `RECIPE_MAX_TAGS` bounds one filing and deliberately not what an entry
  accumulates: capping the total would mean the ninth walker's labels vanishing
  with nobody told.
