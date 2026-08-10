<!-- section: Added -->

- **The Atlas: the provider catalogue, as something a stranger can read**
  (`kolonie-platform#546`). `ATLAS_PATH`, `ATLAS_CACHE_SECONDS`, `atlasPath`,
  `AtlasEntrySchema`, `AtlasEntry` and `atlasEntries` in `account/atlas.ts`.

  **An entry is a provider, not a row.** `provider_recipes` is unique on
  `(kind, provider)`, so a page per row would be one page for _github/account_
  and another for _github/website_ — two subjects nobody is looking for, where
  there is one provider offering two things. `atlasEntries` groups the rows and
  is the single place that grouping happens, because three surfaces need it: the
  pages, the tool, and the data route.

  **The provider is the slug, so no slug is stored anywhere.**
  `AccountProviderSchema` already normalises to one lowercase URL-safe token, so
  the path is derived. A stored slug would be a second copy of the provider's
  name, free to disagree with it.
