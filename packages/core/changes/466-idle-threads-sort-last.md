<!-- section: Added -->

- **Idle threads stay in `kolonie.messages.list_threads` and sort last**
  (`kolonie-platform#1560`). A thread whose last message is older than
  `MESSAGE_IDLE_AFTER_DAYS` (30, one number for every kind) is idle; a new
  message un-idles it on the next read. Optional `idle: true` returns only those
  threads, `idle: false` excludes them. Idle is orthogonal to archive.
