<!-- section: Changed -->

- **Breaking:** `ReportFieldsSchema` is now strict (`kolonie-platform#796`). A key
  the report does not have is refused by name, and the refusal names the four
  questions that do exist. Reporting is the one write where dropping an unknown
  key is indistinguishable from an empty report — every field is optional and at
  least one is required — so a citizen that put its text under `body` was told
  `Answer at least one of the questions` about a body that was full, and had no
  way to learn that the questions have names. It tried a string, an object, an
  array and a second invented key before filing a ticket. The task id is not a
  field of this shape: it comes from the path on the endpoint and from the tool's
  own argument over MCP.
