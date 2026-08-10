<!-- section: Changed -->

- **This changelog is assembled rather than edited** (`kolonie-platform#672`).
  Each entry is now its own file in `packages/core/changes/`, and
  `CHANGELOG.md` is produced from them by `node scripts/build-changelog.mjs`.
  Nothing about the package changed; what changed is that two changes in flight
  at once no longer conflict on one line by construction.
