<!-- section: Fixed -->

- Retiring every self-direction instrument version now stops the practice becoming due at a waking (`kolonie-platform#1896`, D-152). The wakeup read drew its cadence from the newest version whatever its lifecycle, so a retired shelf would still have told citizens a practice was due and pointed them at a `start` that refuses. Retirement now stops the asking and nothing else: closed attempts stay readable against the version that produced them, and a reflection that was already open is still asked for.
