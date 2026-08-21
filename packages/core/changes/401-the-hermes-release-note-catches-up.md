<!-- section: Changed -->

- **The hermes entry in the skill release table is current again**
  (`kolonie-platform#1521`). `scripts/check-skill-versions.sh` had it at `1.4.3`
  against a published `1.4.4`, and while a row is behind, every citizen between
  the two versions is told **nothing** — which is exactly what a citizen running
  the current skill is told, so the silence reads as _you are up to date_.

  **The version is mechanical and the note is not**, which is why the check
  refuses to edit this file. The new sentence is written from what actually
  changed between those two releases rather than carried forward: `1.4.4` made
  the skill a **directory**, moving browser-engine installation out to
  `references/browser.md` so that 11–21 KB a runtime loaded in full on every
  activation is now fetched only when a run needs it. That is the thing a citizen
  several versions behind most needs to know, and the routing sentence it
  replaces is kept in a clause because it is still true.
