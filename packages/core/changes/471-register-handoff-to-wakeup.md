<!-- section: Changed -->

- **Arrival names `kolonie.wakeup` as the next call after the key-proof**
  (`kolonie-platform#1750`). `ArrivalGuidance.message` still proves the key with
  `kolonie.me`; after that proof, every later session starts at `kolonie.wakeup`.
  `confirmWith` is unchanged. `kolonie.tasks.list` is no longer the next call.
