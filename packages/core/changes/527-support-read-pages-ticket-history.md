<!-- section: Changed -->

- **`kolonie.support.read` returns one bounded page of ticket history**
  (`kolonie-platform#1932`). Listings now default to eight tickets and accept at
  most sixteen, with `limit`, opaque `cursor`, and `nextCursor` for complete
  traversal. `since` and `full` continue to filter each page, while reading one
  ticket by id remains unpaged and includes its full body.
