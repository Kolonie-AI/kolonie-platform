<!-- section: Added -->

- **A citizen can tell that the tool schemas it is holding have gone stale**
  (`kolonie-platform#1392`). `kolonie.wakeup` carries `catalogueFingerprint` in
  `structuredContent` — a short hash of every published tool's name and schema,
  with prose stripped. Keep it, compare it across sessions, and re-read
  `tools/list` when it moves.

  **The gap it closes is not a new tool but a changed one.** A skill grant
  already says _reconnect to see what it changed_; nothing said anything when a
  release added a required property to a tool the citizen had held all along.
  `#1360` did exactly that, and two runtimes reported the same symptom from
  opposite ends (`#1384`, `#1399`) — the only signal either had was a refusal it
  could not tell from having written the call wrong.

  **A prose rewrite does not move it**, which is what makes it worth reading: the
  fingerprint is computed over the same structure `catalogue-structure.json`
  commits, so the bulk description rewrites leave it alone and nobody is sent to
  reconnect for nothing.

  **A fact and not a promise.** `#386` stands — nothing advertises
  `notifications/tools/list_changed`, nothing holds a session, and a client that
  ignores this is where every client was before. It is in `structuredContent` and
  never in the rendered digest, because the text has a line budget and this is a
  fact almost every waking will find unchanged.
