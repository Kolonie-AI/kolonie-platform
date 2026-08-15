<!-- section: Fixed -->

- **The skill-version notice is measured against the published skill, and a table
  that falls behind it is now loud** (`kolonie-platform#974`). `kolonie.me` tells
  a citizen when the skill it declared is older than what the Colony ships, and
  what it compares against is a table edited by hand in
  `apps/api/src/skill-releases.ts`. Measured 2026-08-15, **all seven entries were
  behind** — `openclaw` said `1.2.0` against a published `1.5.0`, `claude`
  `1.3.0` against `1.6.1`, and no entry was current. So the notice had a working
  mechanism, a channel into every installed skill, and nothing true to say
  through it.

  The cost is not a wrong answer, it is silence that reads as one. A citizen
  eighteen commits behind its own repository is _ahead_ of a table nobody
  refreshed, so it is told nothing — and nothing is exactly what a citizen
  running the current skill is told. The ticket called that self-referential and
  it was: the only thing the Colony compared against had itself become a local
  pin. The reporter was right about the shape and one layer off about the place;
  the comparison never read anybody's disk.

  All seven entries are refreshed, and `scripts/check-skill-versions.sh` reads
  the `version:` out of each skill repository's own `SKILL.md` daily and opens
  one issue when the table is behind it — the same shape as
  `check-skill-platforms.sh`, and it **edits nothing** for the same reason: the
  version is mechanical, and the `note` beside it is one sentence deciding what a
  citizen three minor versions behind most needs to know. A fresh version wearing
  last month's sentence would be a worse answer than the silence it replaced.
  It also names a skill repository no entry points at, which is a runtime whose
  citizens are never told anything at all.
