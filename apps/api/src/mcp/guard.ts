import type { ApiError, StandingHint } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpLog } from './dependencies.js'

/**
 * How every tool answers a refusal.
 *
 * The same `ApiError` the HTTP surface returns, in both halves of the result, so
 * an agent that has learned one error vocabulary does not have to learn a second
 * on the other surface — and so a model reading the text and a client parsing the
 * structure are told the same thing.
 */
export function toolError(error: ApiError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
    structuredContent: { error },
  }
}

/**
 * What a tool answers when it throws something nobody planned for (#171).
 *
 * **Byte-identical to what `app.setErrorHandler` returns for the same fault**,
 * and deliberately so. A citizen was once handed `ENOENT: no such file or
 * directory, open /app/apps/packages/verifiers/assets/vision/metadata.json` as a
 * tool result, while the same fault over HTTP answered this — so the two doors
 * gave different answers to one problem and only one of them was the decided
 * one.
 *
 * An exception message is the one string in the process with no rule about what
 * it may contain: a query, a path, a connection string, another citizen's
 * identifier. And an agent that reads `ENOENT` has no stable `code` to branch
 * on, so it cannot tell a fault it should retry from one it should report, which
 * AGENTS.md §3 makes the entire point of having codes.
 */
const INTERNAL_TOOL_ERROR: ApiError = { code: 'internal', message: 'Internal error.' }

/**
 * Make every tool this server will ever register answer `internal` instead of
 * handing the caller its exception.
 *
 * **Patched onto the instance rather than written into each handler.** The rule
 * is *no tool leaks an exception*, and a rule enforced at each of forty-odd
 * registrations is the rule the forty-fourth will not follow. Here the set is
 * closed by construction: every registration goes through this, including one
 * made after `createMcpServer` has returned, and its author does nothing to be
 * covered.
 *
 * **It wraps the handler's body, not the transport.** A protocol or transport
 * failure never reaches this and keeps whatever the SDK does with it; what is
 * caught here is one tool's own throw.
 *
 * **The anticipated refusals are untouched.** Every `toolError` return in this
 * file is an outcome the code reasoned about and keeps its own code and message.
 * This catches only what nobody reasoned about.
 */
export function guardTools(server: McpServer, log: McpLog, hint?: DueStandingHint): void {
  const register = server.registerTool as unknown as ToolRegistration

  const guarding: ToolRegistration = (name, config, handler) => {
    const guarded = async (...args: unknown[]): Promise<CallToolResult> => {
      try {
        return await withHint(await handler(...args), hint)
      } catch (thrown) {
        // The tool's name goes with it: a stack alone does not say which of the
        // Colony's entry points a citizen was standing at when this happened.
        log(`kolonie-api: tool ${name} threw`, thrown)
        return toolError(INTERNAL_TOOL_ERROR)
      }
    }

    // `config` is passed through untouched, so the schemas the SDK derives the
    // real signature from are exactly the ones each registration declared.
    return register.call(server, name, config, guarded)
  }

  server.registerTool = guarding as unknown as McpServer['registerTool']
}

/**
 * Whether this call is due a standing hint, asked once per result (`#231`).
 *
 * Undefined for the unauthenticated tier and for a server built without one: a
 * stranger has no standing to be told about, and a hint that could attach to
 * `kolonie.register` would be a line addressed to nobody.
 *
 * **Asking is what spends the citizen's one hint for this run**, so the guard is
 * the only caller and calls it exactly once per non-error result. That is why it
 * is a function taken here rather than a value computed in `create-server.ts`:
 * a value would have to be computed for every call, including the forty in a
 * session that will never carry one.
 */
export type DueStandingHint = () => Promise<StandingHint | undefined>

/**
 * Attach the citizen's one line, if the Colony has one for it.
 *
 * **Both halves, on the `toolError` precedent above**: a text block for the
 * model and a field in `structuredContent` for a client that parses. A client
 * that reads neither is unaffected — nothing about the result it already
 * understood changes, and the addition is additive in both places.
 *
 * **Never on an error result.** A refusal is a vocabulary this codebase is
 * careful about, and a second, unrelated sentence appended to one is how an
 * agent learns to read the whole block as prose. The hint is also not spent: the
 * next successful call in the run carries it instead.
 */
async function withHint(
  result: CallToolResult,
  hint: DueStandingHint | undefined,
): Promise<CallToolResult> {
  if (hint === undefined || result.isError === true) return result

  const attached = await hint()
  if (attached === undefined) return result

  return {
    ...result,
    content: [...result.content, { type: 'text', text: attached.text }],
    structuredContent: { ...(result.structuredContent ?? {}), hint: attached },
  }
}

/**
 * Registration as the guard needs to see it: a name, a config it only passes
 * through, and a handler it wraps.
 *
 * The SDK's own signature is generic over the input and output schemas, and it
 * cannot be reflected on — `Parameters<McpServer['registerTool']>` resolves to
 * `never`, so destructuring it does not compile. The shape is therefore restated
 * here and reconciled with a cast at each of the two boundaries, which is
 * contained: nothing between them depends on the schema types, because the guard
 * never reads an argument or a result. It forwards both.
 */
type ToolRegistration = (
  name: string,
  config: object,
  handler: (...args: unknown[]) => CallToolResult | Promise<CallToolResult>,
) => unknown
