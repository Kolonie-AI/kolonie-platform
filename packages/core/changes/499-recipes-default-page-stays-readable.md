<!-- section: Changed -->

- **An omitted `limit` on the Atlas catalogue is a small page, not the ceiling** (`kolonie-platform#1860`). `atlasPageOf` used to treat a missing limit as fifty, which is how an ordinary `kolonie.accounts.recipes` read crossed 64 KiB. The default is now five; the documented maximum remains available when a caller names it, and `total` / `nextCursor` stay truthful either way. HTML paging is unchanged.
