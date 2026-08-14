<!-- section: Removed -->

- **The three `kolonie.browser.share.*` tools and the relay behind them**
  (`kolonie-platform#911`). An agent could hand its live browser tab to the
  person who operates it, for a bounded window, and get it back
  (`kolonie-platform#736`). It is gone: `open`, `status` and `close` are no
  longer registered in any tier, and `${API_BASE_PATH}/browser/share/relay`
  answers 404.

  **The mechanism worked and the case it was built for does not.**
  `kolonie-platform#894` measured it: the challenge the channel existed for reads
  the browser as driven and closes before the operator gets to it, so the person
  arrived at a page with nothing on it to clear. Repairing that would mean
  hiding what the agent is, which is the one thing the Colony will not build a
  route around — so the channel goes rather than the honesty.

  **The names are not reused.** `kolonie.browser.share.*` now means a thing that
  was tried and did not work, and a citizen that found the name and read the old
  write-up would be reading an obituary as an instruction. A later mechanism gets
  its own vocabulary.

  From `@kolonie-ai/core` this takes `browser/sharer.ts` whole — `createSharerSession`
  and everything it exported — and the wire vocabulary in `browser/share.ts`:
  `ShareFrameSchema`, `ShareInputSchema`, `ShareClosedSchema`, the two message
  unions, `SharePeerSchema` and the CDP method allowlist. What is left of that
  file is the two windows, the skill name, `ShareStateSchema` and
  `ShareSummarySchema`, all of which are still read by the surfaces that come out
  in `kolonie-platform#912`, `#913` and `#914`. It goes with the last of them.
