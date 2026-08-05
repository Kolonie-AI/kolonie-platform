import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * Take the JSON Schema boilerplate out of what is published, and change nothing
 * about what is enforced (`#382`).
 *
 * ## What is removed, and why each is meaningless to a reader
 *
 * Measured against the surface on 2026-08-05, 101 tools on the steward tier:
 *
 * | | Times | Bytes |
 * |---|---:|---:|
 * | `"$schema": "http://json-schema.org/draft-07/schema#"` | 98 | ~5,000 |
 * | A UUID spelled as a regex, beside `"format": "uuid"` | 37 | 6,142 |
 * | An ISO 8601 timestamp spelled as a regex, beside `"format": "date-time"` | 7 | 1,827 |
 *
 * **The dialect declaration says nothing the protocol has not already said.**
 * MCP positions this object as a tool's input schema; nothing downstream
 * branches on which draft it claims to be, and no client needs to be told.
 *
 * **A regex beside a `format` is the same fact twice, in the unreadable
 * spelling.** A model does not construct a UUID by reading a character class —
 * it copies the id the Colony just handed it. The leap years in the timestamp
 * pattern are expanded by hand across 261 bytes, in a field whose neighbour
 * already says `date-time`. Zod emits both; only one of them is read.
 *
 * ## What is deliberately kept
 *
 * **A pattern with no `format` beside it.** Four survive, and they are short and
 * they carry the only statement of their rule: a kebab-case slug (26 bytes), a
 * six-digit code (7), a lowercase local part (23), a key path (31). Dropping
 * those would delete a bound rather than a duplicate, which is the opposite of
 * this change.
 *
 * ## What this does not touch
 *
 * **Validation.** The server parses every argument with Zod on the way in, and
 * that is unchanged — a caller that sends a malformed id is refused by the same
 * code with the same message it got yesterday. This is about what is *published*
 * to the client, not about what is *enforced* at the boundary, and the two were
 * never the same object.
 *
 * ## Why it hangs off `connect` rather than off each registration
 *
 * The SDK builds a tool's JSON Schema from its Zod shape when the list is asked
 * for, so there is nothing to intervene in at registration time. Wrapping the
 * transport's `send` is the one seam every caller passes through — production
 * over HTTP and the suite over an in-memory pair alike — which is what makes the
 * measurement in `surface-size.test.ts` a measurement of what is served rather
 * than of what a test constructed. It is the same argument `guardTools` makes
 * for patching the instance: a rule applied at each of a hundred registrations
 * is the rule the hundred-and-first will not follow.
 */

/** JSON Schema keywords whose regex twin is redundant once the keyword is there. */
const FORMATS_THAT_REPLACE_A_PATTERN = new Set(['uuid', 'date-time'])

/**
 * Strip the noise from one schema object, recursively.
 *
 * Returns a new object rather than mutating: the schema handed in belongs to the
 * SDK, which caches it across requests on a long-lived server, and a mutation
 * here would be a change to something the SDK believes it still owns.
 */
export function withoutSchemaNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSchemaNoise)
  if (value === null || typeof value !== 'object') return value

  const source = value as Record<string, unknown>
  const format = source['format']
  const redundantPattern =
    typeof format === 'string' &&
    FORMATS_THAT_REPLACE_A_PATTERN.has(format) &&
    typeof source['pattern'] === 'string'

  const pruned: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(source)) {
    if (key === '$schema') continue
    if (key === 'pattern' && redundantPattern) continue
    pruned[key] = withoutSchemaNoise(nested)
  }

  return pruned
}

/** A `tools/list` result with its schemas pruned, or the message untouched. */
const leanMessage = (message: JSONRPCMessage): JSONRPCMessage => {
  if (!('result' in message) || message.result === undefined) return message

  const result = message.result as Record<string, unknown>
  if (!Array.isArray(result['tools'])) return message

  return {
    ...message,
    result: { ...result, tools: withoutSchemaNoise(result['tools']) },
  } as JSONRPCMessage
}

/**
 * Publish lean schemas on every list this server will answer.
 *
 * Called once by `createMcpServer`, so nothing an author of a new tool does or
 * forgets can opt out of it.
 */
export function publishLeanSchemas(server: McpServer): void {
  const connect = server.connect.bind(server)

  server.connect = async (transport: Transport, ...rest: unknown[]): Promise<void> => {
    const send = transport.send.bind(transport)
    transport.send = (message, options) => send(leanMessage(message), options)
    return connect(transport, ...(rest as []))
  }
}
