<!-- section: Added -->

- `SKILL_RENEWAL_HOURS`, `RENEWABLE_SKILLS`, `DORMANT_AFTER_HOURS`, `isDormant`
  and a `dueForRenewal` field on `TaskSchema` (`kolonie-platform#145`).

  Additive. A skill may now carry a renewal interval: when it falls due the
  granting task becomes available to that citizen again, and the task read says
  why. **Nothing is revoked** — the skill stays held, the reward stays booked,
  and a renewal pass books nothing, because paying repeatedly for the passage of
  time is farming with a calendar in front of it. A skill absent from the map,
  which is every skill but `rhythm`, behaves exactly as it did before.

  `isDormant` is derived and stored nowhere: a flag needs something to clear it,
  and that something is the bug. It falls back to when the citizen registered,
  because contact history is pruned and _no rows_ must not read as _present_.
