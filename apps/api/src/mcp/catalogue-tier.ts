import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PublishedTool } from './catalogue-size.js'
import { fingerprintOf, structureOf } from './catalogue-structure.js'
import { withoutSchemaNoise } from './published-schema.js'

/**
 * The fingerprint of the catalogue *this server* would serve (`#1917`).
 *
 * ## Why the handshake needs its own computation
 *
 * `CATALOGUE_FINGERPRINT` is a shipped constant, generated from the citizen tier
 * and verified against what a real client receives. That is the right answer for
 * a citizen and the wrong one for a stranger: D-013 builds the tiers by
 * registering *fewer tools*, so which tools exist is a property of the assembled
 * server rather than of the build. Measured 2026-09-09, a stranger is served 8
 * tools against a citizen's 128 — handing it the citizen's string would be a
 * fingerprint that never equals what it is compared against, which is worse than
 * no fingerprint at all.
 *
 * So this asks the server what it actually holds. On the citizen tier the answer
 * is the shipped constant, and `catalogue-tier.test.ts` asserts exactly that —
 * which is what keeps two ways of arriving at the same fact from drifting apart.
 *
 * ## The published shape, not the SDK's
 *
 * A client never sees the SDK's raw schema: `publishLeanSchemas` strips the
 * dialect declaration and the regex twin of a `format` on the way out, and the
 * committed fingerprint is computed over what the client received. So the same
 * exported `withoutSchemaNoise` is applied here rather than a second copy of its
 * rules, and the equality test is what proves the reproduction faithful.
 *
 * ## Read at the handshake, before any client has asked for a list
 *
 * `#1916` measured the ordering that decides this: a conformant client
 * initialises over `POST` and opens its stream afterwards, so `initialize` is
 * answered before `tools/list` is ever called. The tools are known at that
 * point — they were registered when the server was built — but the SDK exposes
 * no public way for a server to enumerate its own. The one seam that answers is
 * the `tools/list` handler it registered on itself, which is what this calls.
 */

/**
 * What the SDK privately holds, named as narrowly as it can be.
 *
 * **A structural cast, and the alternative was worse.** The MCP SDK offers a
 * server no public enumeration of its own tools. This names the one field that
 * answers and the one shape it is used at, so an SDK that moves either is a
 * compile error at this line rather than a silently wrong string in production.
 */
interface ServerInternals {
  readonly _requestHandlers?: Map<
    string,
    (request: unknown, extra: unknown) => unknown | Promise<unknown>
  >
}

/** What the `tools/list` handler answers with, as much of it as this reads. */
interface ListedTools {
  readonly tools?: readonly PublishedTool[]
}

/**
 * The fingerprint for the tier this server serves, or `undefined`.
 *
 * **`undefined` is a real answer and is the safe one.** An SDK upgrade that
 * moves the handler, or a server built without tools, reaches the handshake as
 * *say nothing* — which is the pre-`#1917` handshake, and every client that ever
 * connected coped with it. A wrong string would be read as *your binding is
 * stale* forever, or worse as *nothing changed* when something had.
 */
export async function tierFingerprint(server: McpServer): Promise<string | undefined> {
  const handler = (server.server as unknown as ServerInternals)._requestHandlers?.get('tools/list')
  if (handler === undefined) return undefined

  try {
    const listed = (await handler(
      { method: 'tools/list', params: {} },
      { signal: new AbortController().signal, requestId: 0 },
    )) as ListedTools

    if (listed.tools === undefined) return undefined

    return fingerprintOf(
      structureOf(
        listed.tools.map(
          (tool) =>
            ({ ...tool, inputSchema: withoutSchemaNoise(tool.inputSchema) }) as PublishedTool,
        ),
      ),
    )
  } catch {
    // The handshake is not the place to fail. A server that cannot describe its
    // own catalogue still serves it, and a client that gets no fingerprint is
    // exactly where every client was before this existed.
    return undefined
  }
}
