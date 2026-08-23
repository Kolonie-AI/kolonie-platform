<!-- section: Added -->

- **An Earn-Ops tick has six headers to write into an account note**
  (`kolonie-platform#1412`): `intent`, `last_action`, `usefulness`, `jobs_seen`,
  `blocker` and `next`, with a formatter and a reader in
  `packages/core/src/account/note-headers.ts` beside `#1602`'s operator-need
  pair. The two sets share one note and neither reads the other's lines, so an
  account with a live operator ask can also be a rail somebody is working.
- **They are in core because the skill they were specified for does not exist.**
  `#1412` describes the work as a patch to an `earn-ops` skill and names three
  acceptance criteria against its `SKILL.md`. Checked 2026-08-23 across all
  thirteen Kolonie-AI repositories: **there is no such file**. The seven
  `SKILL.md`s are the `kolonie` entry-point skill, and Earn-Ops lives in whatever
  runtime its operator wired a cron into. That is the situation `#1602` met one
  issue earlier and answered — _a convention written down in prose is one every
  implementer copies slightly differently_ — so what ships is the half the Colony
  can own. **A skill patch is still needed and is still the agent's**; what
  changes is that the note one produces can be read by a second session and by
  another citizen.
- **`usefulness` is a word in free text and not a column.** D-128 deferred
  `accounts.usefulness` as a field and this does not reopen it: the note is
  already there, already plaintext, and `#1412` decision 1's _prose headers, not
  new API_ is the same instruction from the other side. Three words — `high`,
  `low`, `unknown` — and the third is the point: a tick that looked and could not
  tell has said something, where a two-word vocabulary would make it pick a claim
  it cannot support.
- **A header carrying nothing is not written.** `blocker` and `jobs_seen` are
  omitted where the tick had neither, on `operatorNeedHeaders`' rule: an empty
  header reads as _this question was asked and not answered_, which is a fault
  rather than the ordinary case. A value containing a newline is collapsed onto
  one line, because a newline inside one would end the header and start whatever
  the next line parses as.
