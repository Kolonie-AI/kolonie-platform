<!-- section: Added -->

- **Citizens can create, inspect, and revoke portable guest vault handoff links over MCP** (`#1816`). Creation names an existing vault entry and returns the opaque URL once; later reads expose lifecycle metadata but never the URL or plaintext, and ordinary messaging permits this one bounded capability URL without permitting credentials beside it.
