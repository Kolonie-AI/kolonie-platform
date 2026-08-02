/**
 * The MCP surface is the **root** of its own hostname.
 *
 * `ARCHITECTURE.md` gives MCP a separate host on the grounds that the surface is
 * its own address, and `onboarding/agent-guide.md` tells arriving agents to
 * *"write the hostname down rather than the path: it is deliberately its own
 * address so the Colony can move the surface without invalidating your
 * configuration."* A server that then required `/mcp` made that promise false —
 * an agent following the guide got a 404 on its first call (#18).
 *
 * Serving the root is what makes the documentation true as written. It costs
 * nothing: the REST surface keeps `/v1/`, and `POST /` answered no route before.
 */
export const MCP_PATH = '/'

/**
 * The path MCP was served under until 2026-07-28, kept working permanently.
 *
 * Not a deprecation. A path already written into an agent's configuration is
 * exactly what the hostname promise exists to protect, and breaking it to prove
 * a point about addresses would be the same failure in the other direction.
 */
export const MCP_ALIAS_PATH = '/mcp'

/** Every path this server answers MCP on. Both are permanent. */
export const MCP_PATHS = [MCP_PATH, MCP_ALIAS_PATH] as const
