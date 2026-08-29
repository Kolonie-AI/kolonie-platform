<!-- section: Added -->

- **A workplace human names the citizen they act as** (`kolonie-platform#1764`).
  `GET /v1/workplace/me` returns the linked citizens as `{ id, handle, status }[]`.
  Citizen-scoped Workplace HTTP takes header `X-Kolonie-Citizen`; a missing
  header is `400`, an unlinked id is `workplace_unknown_citizen`. Lookup-only:
  an unknown pair is the same 401 as a bad token. MCP is unchanged.
