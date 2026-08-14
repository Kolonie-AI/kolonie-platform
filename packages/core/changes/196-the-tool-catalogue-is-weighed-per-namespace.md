<!-- section: Added -->

- **The tool catalogue is weighed per namespace, beside what citizens manage
  with it** (`kolonie-platform#888`). `#388` weighs the whole MCP surface a
  citizen loads; that number says the context is expensive and says nothing about
  which part of it is. `measureCatalogue` groups the served list by namespace and
  reports tools, bytes, bytes per tool and **prose bytes** — the tool description
  plus every `description` string nested in the input schema, which is the half a
  consolidation would actually move. Measured **2026-08-14** against
  `mcp.kolonie.ai` with
  `KOLONIE_MCP_URL=… KOLONIE_API_KEY=… DATABASE_URL=… node scripts/measure-mcp-catalogue.mjs`:
  **97 tools, 160,346 bytes, 66.2 % of it prose**, with `accounts` at 34,491
  bytes and `academy` the heaviest per tool at 4,166.
- **And beside it, whether the rungs that send citizens there get cleared.**
  Bytes alone would answer _which namespace to cut_ with _the biggest one_, which
  is the wrong answer if that namespace is where citizens succeed.
  `namespaceSuccess` reports the pass rate and the rejected-submission rate of the
  rungs whose instructions name each namespace: on the same date `vault` clears
  64.6 % of 48 closed attempts and `quests` rejects 62.5 % of 24 judged
  submissions.
- **The edge from a rung to a namespace is the prose, because nothing else
  joins them.** No column says which tools a rung is about;
  `instructionsByTaskType` hands out the instructions per rung type and the
  existing `toolNamesIn` parser reads the calls out of them, filtered to names the
  live catalogue actually serves. A rung naming several namespaces is counted in
  each of them **undivided** — splitting one attempt across three namespaces would
  invent a precision nothing measured — so the columns do not sum to the Academy,
  and the report says so above the table.
- **It measures what is served, not what this repository ships.** The script
  connects as an ordinary client and calls `tools/list`, because a measurement of
  something other than the list a citizen actually loads is trusted for exactly as
  long as it takes somebody to act on it. `--tools <file>` weighs a captured list
  where there is no deployment to reach, and the report names which it was.
- **Nothing in it is a gate, and a half it could not measure says so.** There is
  no threshold here: a catalogue that grew is reported and the script exits 0,
  which is `#388`'s decision and `#888` does not reopen it. Without a
  `DATABASE_URL` the Academy half prints _not measured in this run_ rather than
  zeros — a namespace nobody looked at and a namespace with no attempts read
  identically in a table and call for opposite conclusions.
- **No credential in the repository and none on the command line.** The endpoint
  and the key come from the environment or the script refuses, naming what is
  missing; a key passed as an argument is in one shell history and every process
  list on the machine. What is written into the committed report is the _host_,
  never the URL, because a path or a query string can carry a token.
- **`submissionTallies` counts how submissions were judged, per rung**, which no
  aggregate did. `attemptTallies` answers _did citizens get through_; the
  rejection rate is the narrower question of how many of the submissions somebody
  actually judged came back rejected. Timeouts and unjudged submissions are
  reported beside the rate and kept out of it, for the same reason
  `attemptTallies` keeps `obstructed` out of its own: a stalled verification is
  not a rung that was misunderstood.
