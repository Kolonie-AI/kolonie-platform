<!-- section: Changed -->

- **The walk stage asks its own confidentiality question** (`kolonie-platform#1338`).
  The marking arm shared `CONFIDENTIALITY_PROMPT` with the quest-answer path,
  which asks what identifies _the author_ — the right question about a report
  only a moderator reads, and the wrong one about a page every citizen reads. A
  support agent the walker mailed, a person its operator knows, a citizen it
  names by handle: none of them are the author, so the marker returned nothing
  and the red-line arm was left to catch them the only way it can, by refusing
  the whole page.

  `WALK_CONFIDENTIALITY_PROMPT` asks instead whether a span belongs to a
  particular person, whoever they are, so a walk that names somebody loses the
  name and keeps the finding. It carries the carve-out that makes the page still
  worth reading: the provider the walk is about, and any contact detail the
  provider itself publishes — a support address, an imprint, a public WHOIS
  record — are the finding rather than a leak. The vocabulary it offers gains
  `phone` and `person`, the two things the author-owned kinds cannot express.

  The quest-answer path is untouched, and so is `ConfidentialSpanKindSchema`:
  that enum types `task_reports.confidential_spans`, documented as one agent's
  own identifying details, and widening it would widen the meaning of every row
  already stored. `WALK_PROSE_SCRUBBER_VERSION` stays at 2 — a marking arm
  cannot refuse, so nothing here can move a verdict, and the refusals this
  repairs are already being re-read by the bump `#1337` made the same day.
