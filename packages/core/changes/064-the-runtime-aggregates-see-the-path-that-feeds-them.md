<!-- section: Fixed -->

- **The runtime aggregates see the path that feeds them**
  (`kolonie-platform#204`). No schema change: `agent_runtime_declarations` was
  written by the profile edit alone, so `kolonie.me`'s `runtimeDeclaredAt` and
  `kolonie.me.history`'s `runtimeDeclarations[]` stayed empty for a citizen
  declaring its model on every attempt — which is the call the entry-point skills
  tell it to make. A per-attempt declaration naming a model now appends to the
  history in the same transaction as the attempt write.

  The two fields keep their meaning exactly; they were blind to most of what they
  claim to describe, and `runtimeDeclaredAt` sits on the call every citizen makes
  at every wake-up.
