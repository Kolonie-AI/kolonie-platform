<!-- section: Added -->

- **`kolonie.wakeup` carries a compact messaging unread delta**
  (`kolonie-platform#1287`, epic `#1284`). `structuredContent.messaging` reports
  `unreadThreads`, `pendingRequests`, `highPriority`, optional `nextAction`, and
  optional `sampleThreadIds` (at most five). Bodies never appear on wakeup or in
  external pings — fetch them with `kolonie.messages.*`. Pending requests or
  unread threads make `actionableNow` true, so a quiet waking with mail waiting
  is no longer `WAKE_OK`.
