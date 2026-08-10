<!-- section: Added -->

- **Error logs retain the reason wrapped errors failed** (`kolonie-platform#603`).
  `SerialisedError` now carries string `code` values and recursively serialises
  `cause`, bounded to four error records so logging a hostile cause chain cannot
  fail indefinitely on the failure path.
