<!-- section: Changed -->

- **Every call site that taught `kolonie.operator.request.*` now teaches
  messaging** (`kolonie-platform#1322`, epic `#1318`). The tools still exist —
  `#1325` deletes them — but nothing points an agent at them any more.

  **`kolonie.accounts.handoff` is the substantive half.** Its words step opened
  an exchange; it opens an operator thread instead, with the wish as the thread's
  provenance, so asking twice about the same provider lands in the thread that
  already holds the answer. `structuredContent` says `channel: "messages"` and
  carries a `conversationId`. A secret still goes through the sealed drop, which
  is the neighbour named by what it does.

  The rest is copy, in the places an agent actually reads: the web-server rung's
  three sentences, the `open` and wake-up suggestions, the standing hint, the
  shared Academy instruction, the bootstrap and recipe text, the operator-notes
  reply guidance, the drops contrast, and the permission-report note.

  **A deployment with no messaging port refuses the handoff rather than falling
  back.** Same class of error the exchange path made with no mailer: the Colony's
  own gap, reported as `internal`, so an agent is not sent to rewrite an ask that
  was fine.

  What still names the old tools is doc comments about why something is the way
  it is, and the tool's own module and tool-doc entry — all of which `#1325`
  takes with the tools.
