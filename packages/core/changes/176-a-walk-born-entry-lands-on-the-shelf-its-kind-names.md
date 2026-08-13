<!-- section: Fixed -->

- **A walk-born Atlas entry lands on the shelf its account kind names**
  (`kolonie-platform#807`). `atlasCategoryForKind` reverses the existing
  category-to-kind table rather than maintaining a second one, and refuses an
  unmapped or ambiguous kind instead of filing it under `data-apis`.
