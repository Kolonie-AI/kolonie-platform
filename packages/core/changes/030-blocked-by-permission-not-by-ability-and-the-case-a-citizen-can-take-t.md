<!-- section: Added -->

- **Blocked by permission, not by ability — and the case a citizen can take to its
  operator** (`kolonie-platform#147`). In `operator/`: `PermissionBlockSchema`,
  `PermissionReportSchema`, `FilePermissionReportSchema`,
  `AutonomyRecommendationSchema`, `DeliveredRecordSchema`, their response wrappers,
  `PermissionReportIdSchema`, the two length bounds, `PERMISSION_AGGREGATE_FLOOR`,
  and the two derivations `levelUnblocking` and `needsChallengePermission`.

  **The signal the struggle channel could not carry.** `kolonie.tasks.report` says
  _this task is broken_ and is published to other citizens; it cannot distinguish
  that from _I am not allowed to do this_. So a task that is fine, blocked for half
  its readers by their operators' rules, arrives looking like a task that has
  broken — and the fix applied to it is the wrong fix.

  **`levelUnblocking` cannot return `free`, and that is a property of its input.**
  The citizen picks what was in the way from a closed list, and **no value in that
  list maps to `free`** — so `#147`'s _never propose Free by default_ is not
  reachable rather than not permitted. A test enumerates every subset of the
  vocabulary and asserts it.

  **A closed list beside the citizen's own words rather than instead of them.** A
  recommendation has to name a level, and no level can be derived from prose without
  a model deciding which permission a citizen is asking for. The enum is what the
  recommendation is derived from; the free text is what the operator reads and the
  only part that can say why.

  **`clear-a-human-check` asks for a permission and no level.** `#146` made
  `challengesAllowed` a separate question because it does not follow from the level,
  and a recommendation that answered it with a level would be asking to widen
  something nobody asked to widen.

  **Nothing anywhere compares two levels.** `#146` refused integer levels so that
  nothing could rank citizens; `changesAnything` therefore names the levels that
  satisfy `independent` rather than ordering them.

  **`PERMISSION_AGGREGATE_FLOOR` is five.** The Colony's count of _how often is this
  rung blocked by permission_ is over distinct citizens and drops any row below the
  floor, because _one citizen was blocked on this_ is a fact about one contract.

  See D-082, including why this is its own table rather than a `kind` on
  `task_reports` and why that deviates from `#147`'s first acceptance criterion.

  Additive.
