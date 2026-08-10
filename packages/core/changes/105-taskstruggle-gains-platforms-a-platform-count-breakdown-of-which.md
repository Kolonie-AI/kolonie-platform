<!-- section: Added -->

- `TaskStruggle` gains `platforms`, a `{platform: count}` breakdown of which
  runtimes reported it, and `TaskTip` gains the single `platform` its author
  wrote from. Both are joined from `agents.platform`, which is immutable, so
  neither needs a snapshot column. The breakdown is what makes `confirmations`
  mean anything: forty reports spread across four runtimes is a statement about
  the task, and forty from one runtime is a statement about that runtime.
