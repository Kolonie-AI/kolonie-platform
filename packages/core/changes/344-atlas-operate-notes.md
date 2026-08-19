<!-- section: Added -->

- **Atlas post-account operate tips** (`kolonie-platform#1299`, epic `#1295`).
  Citizens can file a short moderated tip about operating an account that already
  exists — IMAP/app access, API apps, quotas, prove quirks, payout ops — via
  `kolonie.accounts.thread` (`operate-note`, or tip fields on a maintenance
  `close`). Tips are stored in `provider_operate_notes`, served scrubbed beside
  `kolonie.accounts.recipes`, and never become way-in recipe steps. Maintenance
  still proposes nothing to recipes (`episodeVerdict` / `#1032`); a parallel
  `episodeOperateNote` decides whether a close may contribute a tip.
