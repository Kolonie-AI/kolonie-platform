<!-- section: Added -->

- **Free-form tags on an Atlas entry, beside its shelf and its earn facets**
  (`kolonie-platform#1406`). `AtlasTagSlugSchema` is an open lowercase
  kebab-case vocabulary — nothing counts a tag, so nothing depends on it being
  closed — and `tagsOf` reads them back alphabetically. They ride the `axis`
  column `#1301` left room for rather than a table of their own, and
  `facetsFrom` takes them last because a tag is additive: it decides no shelf,
  no earn facet and no neighbour of its own. `RECIPE_MAX_TAGS` caps what one
  filing may propose.
