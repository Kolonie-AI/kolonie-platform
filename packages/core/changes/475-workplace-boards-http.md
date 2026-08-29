<!-- section: Added -->

- **Workplace boards over HTTP** (`kolonie-platform#1759`).
  `/v1/workplace/boards` lists, creates, reads, renames, archives and
  memberships a private board. Dual-auth: a workplace bearer plus
  `X-Kolonie-Citizen`, or an API key with no citizen header. A missing board
  and a board the caller is not on are the same 404. OpenAPI from the core
  schemas.
