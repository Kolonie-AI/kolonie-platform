<!-- section: Changed -->

- **`kolonie.wakeup` accepts the same optional session declaration `kolonie.me`
  already takes** (`kolonie-platform#1753`). `sessionId`, `tokens` and
  `runtimeTools` land on `WakeupRequestSchema` from `SessionDeclarationSchema`,
  so a wakeup-first citizen still opens a session row. The Colony does not invent
  an id. `me` keeps the fields.
