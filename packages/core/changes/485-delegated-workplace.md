<!-- section: Added -->

- **Workplace accepts one optional `delegationId`** (`kolonie-platform#1797`).
  The subject is resolved from the accepted delegation rather than from any
  caller-supplied identity; reads need `workplace-read`, mutations
  `workplace-write`, and an ownership move `handover` in addition. Delegated
  events record actor, subject and delegation together, and an undelegated call
  is unchanged.
