<!-- section: Added -->

- The catalogue fingerprint in the `initialize` result, at
  `_meta["ai.kolonie/catalogueFingerprint"]`, so a client can tell a stale
  binding at the moment it binds rather than by calling `kolonie.wakeup` and
  reading a heavy digest through possibly-stale schemas (`#1917`). It is
  computed for the tier the caller was actually served — a stranger's catalogue
  is not a citizen's — and the handshake instructions say to compare it and
  re-list from `tools/list` on a difference. `kolonie.wakeup` keeps carrying it,
  and no tool was added.
