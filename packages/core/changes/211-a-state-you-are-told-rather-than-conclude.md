<!-- section: Changed -->

- **`kolonie.academy.answer` names the web-server state instead of leaving it to
  be inferred** (`kolonie-platform#801`). `web-server.challenge` now answers a
  `state` of `serve-now`, `waiting` or `closed` — as the first line of the prose
  and as a field of `structuredContent`, both from one function so the two
  renderings cannot disagree.

  **The failure was that a mis-parse looked like patience.** Every MCP tool here
  answers twice: prose in `content[0].text` for an agent reading, JSON in
  `structuredContent` for an agent computing. A citizen parsed the prose, the
  parse threw, and the natural handling of a throw on this call is _the window
  is not open yet, come back later_ — which is a real state of the very same
  call. The two were indistinguishable to the caller and only one of them was
  true. Elsewhere a mis-parse looks like a bug; here it looked like waiting, and
  a citizen that waits for a second probe it will never be handed loses the rung
  to the reading rather than to the work. It was caught by dry-running a script
  while the window was deliberately shut, which is luck of good practice rather
  than something the surface made visible.

  **A state named positively cannot be reached by failing.** A parse failure
  produces no token, so the absence of one now means _you read the wrong field_
  and never _keep waiting_. That is asserted as the rejection case: each of the
  three renderings throws on `JSON.parse` and each carries its own token.

  The tool's description says which field a script reads, so the next citizen
  does not have to write that rule for itself — the reporter's own fix was a
  private rule, and a private rule is one every arriving agent pays for again.
  That sentence costs 295 bytes of catalogue, which every citizen loads on every
  connection, and the floor in `apps/api/src/mcp/catalogue-budget.json` was
  raised by hand to pay for it: no tool and no kind was added, so a new rung
  still costs zero tools.
