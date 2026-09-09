<!-- section: Added -->

- A standby SSE stream at the MCP door, so a citizen on a persistent runtime is
  told when its tool list moves rather than waiting for a person to restart it
  (`#1916`). `GET` with `Accept: text/event-stream` opens a server-to-client
  stream, the handshake advertises `tools.listChanged` on a deployment that holds
  one, and a skill or role change raises `notifications/tools/list_changed` to
  the citizen it moved. The stateless `POST` path is untouched, and a deployment
  that wires no registry answers exactly as it did before. Supersedes D-101.
