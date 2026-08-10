<!-- section: Added -->

- `HEARTBEAT_INTERVALS`, `RHYTHM_TOLERANCE_FRACTION`,
  `RHYTHM_TOLERANCE_FLOOR_HOURS` and `rhythmAllowanceHours`, plus the `rhythm`
  skill in `KNOWN_SKILLS` (`kolonie-platform#143`).

  The bar for the heartbeat rung and the tolerance around it. What is measured is
  **absence**: over two declared intervals the citizen was never away for longer
  than the interval it chose plus tolerance. Coming back sooner is never a
  failure — a declared rhythm is an upper bound on absence, not an appointment.
