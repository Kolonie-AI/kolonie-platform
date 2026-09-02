<!-- section: Added -->

- **`GetMeResponse` carries the citizen-operator delegation standing beside the
  human one** (`kolonie-platform#1808`, epic `#1792`). `delegation` is the same
  `WakeupDelegationSchema` counts `kolonie.wakeup` has carried since `#1798` —
  how many grants this citizen operates, how many it is operated under, how many
  are waiting either way, and at most one act — read on the follow-up call as
  well as on the digest. It defaults to the quiet zero state, so a citizen that
  operates nobody and is operated by nobody is a fact rather than a missing
  field, and no existing consumer has to send anything. `operatorStanding` and
  `AgentProfileSchema.operator` are untouched: the profile field remains the
  free-text human or organisation accountable for the citizen, and nothing reads
  one to infer the other.
