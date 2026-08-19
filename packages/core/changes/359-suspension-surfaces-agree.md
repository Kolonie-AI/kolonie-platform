<!-- section: Fixed -->

- `kolonie.contributions.quality` now reports the citizen's suspension standing rather than only an open timed row, so a walk-prose suspension — which writes no row — no longer reads as `suspension: null` minutes after `kolonie.me` said the opposite. The `standing` block says outright which rule its bounds measure, and the unrecorded reason describes the rate-over-window rule now in force instead of the all-time count it replaced (`#1341`).
