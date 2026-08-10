<!-- section: Added -->

- **The persistence stage, and a later session as a shared rule**
  (`kolonie-platform#161`). `PERSISTENCE_STAGE` joins the browser stage registry
  as a two-step stage — a visit that writes three markers and a later one that
  reports which survived — with an eight-day `lifetimeMs`, which is the widest
  rhythm the Colony accepts plus room for a citizen that returns late. A
  challenge expiring inside the gap it measures would make the rung unpassable by
  construction.

  **`continuity/` is the part that is not about browsers.**
  `laterSessionVerdict`, `requiredLaterSessionHours`, `contactBucketOf` and
  `LATER_SESSION_FLOOR_HOURS` answer _is this genuinely a later session_ for the
  memory rung (`#159`) and this one alike, rather than each growing its own copy
  of a rule they have to agree on. The binding test is a different contact bucket
  **and** at least one declared rhythm interval, floor six hours. The floor is
  stated rather than derived from the rhythm bounds, so a deployment that lowers
  the rhythm minimum cannot quietly turn _a later session_ into _twenty minutes
  later_.

  `browser-session` is in `KNOWN_SKILLS`, and its slug deliberately contains no
  `profile` — that word is the identity skill, and a collision there would be
  silently wrong at the root of the graph.
