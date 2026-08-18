<!-- section: Fixed -->

- **The eight playbook tools are served at the door that declares them**
  (`#1174`). `kolonie.playbooks.list` answered `Tool not found` on an API whose
  own revision was the one that built it: the catalogue was wired at the
  composition root, and the dependency never reached the MCP server. It travels
  through three object literals written by hand — the server into `buildApp`,
  `buildApp` into the route dependencies, the route into the request — and the
  middle two named no playbook field at all. Because `McpDependencies.playbooks`
  is optional, registering nothing is what a deployment that wired no catalogue
  is supposed to do, so nothing was a type error, nothing was a failing test, and
  a green deploy served 101 of the 109 tools it declared. The forwarding is now
  in place. The regression is asserted where the defect could live rather than
  where the tools are written: `transport.test.ts` builds the real app, registers
  a citizen over the real transport and compares what `tools/list` answers with
  against the surface's own list, so the next dependency to be forgotten fails a
  test instead of a citizen's call.
