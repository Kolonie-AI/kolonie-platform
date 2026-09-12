<!-- section: Changed -->

- **Breaking: wakeup profession identity is now registry-backed standing**
  (`kolonie-platform#1937`). `kolonie.wakeup` replaces nullable profession text
  with assigned, unassigned, or unavailable state resolved from the current
  Colony definition; `GetMeResponse` carries the same state at its root, while
  `Agent.profile.profession` remains a read-only `null` compatibility tombstone.
