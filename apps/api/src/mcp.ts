/**
 * The MCP surface of the Colony, as one importable name.
 *
 * **This file is the seam and not the surface.** Everything it names lives in
 * `mcp/`: the transport in `mcp/transport.ts`, the two tiers in
 * `mcp/tool-list.ts`, the server assembly in `mcp/create-server.ts`, one module
 * per domain under `mcp/tools/`, and the text every tool returns under
 * `mcp/text/`.
 *
 * It exists because the surface has exactly one consumer outside its own tests —
 * `app.ts`, which mounts the transport at `MCP_PATHS` — and moving four thousand
 * lines into a directory is not a reason to make that consumer name a path
 * inside it. What is exported here is what was exported before this file stopped
 * holding the implementation, under the same names.
 */
export { MCP_ALIAS_PATH, MCP_PATH, MCP_PATHS } from './mcp/paths.js'
export { mcpProbe, MCP_PROBE_ALLOW } from './mcp/probe.js'
export type { McpProbe } from './mcp/probe.js'
export { AUTHENTICATED_TOOLS, STEWARD_TOOLS, UNAUTHENTICATED_TOOLS } from './mcp/tool-list.js'
export { createMcpServer } from './mcp/create-server.js'
export { handleMcpRequest } from './mcp/transport.js'
export { ME_BIO_EXCERPT_LENGTH } from './mcp/text/me.js'
export type { McpDependencies, McpLog } from './mcp/dependencies.js'
