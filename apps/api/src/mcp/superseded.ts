import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * A name that still answers and is no longer offered (`#890`).
 *
 * ## Why the two halves have to come apart
 *
 * A consolidation that renames eight tools into one has two obligations that
 * look contradictory. The catalogue has to get smaller — that is the whole
 * point, and `catalogue-budget.test.ts` measures it from what a real client is
 * served. And a skill file written last week has to keep working, because the
 * seven skill repositories are not deployed by us and a rename that breaks them
 * on the hour is a rename that breaks agents mid-task.
 *
 * Both are satisfiable at once only if the old name is **callable but not
 * listed**. So the eight registrations stay — they are still in
 * `AUTHENTICATED_TOOLS`, they still answer, `registeredTools()` still finds
 * them for the prose-parity checks — and this removes them from `tools/list` on
 * the way out.
 *
 * ## Why this is not the withdrawal doctrine
 *
 * `withdrawn-browser-share.test.ts` requires a withdrawn name to answer *as
 * unknown*: a channel that no longer exists must not tell an agent *you may
 * not*, because that is a thing to go and earn and the agent will spend a
 * rung's worth of effort earning it. A superseded name is the opposite case.
 * It exists, it works, and what the caller needs to learn is where it moved
 * to — which the tool's own answer says, in the sentence naming its successor.
 *
 * ## Why it hangs off `connect`
 *
 * The same seam and the same argument as `publishLeanSchemas`, which this is
 * written after: a rule applied at each of a hundred registrations is the rule
 * the hundred-and-first will not follow. Filtering the list where the list
 * leaves is the one place no future author can forget.
 *
 * ## When each name goes
 *
 * `removeAfter` is a date and not a mechanism. Nothing here deletes anything on
 * it — removing a name means deleting its registration in a commit, once the
 * skill repositories name the successor. The date is what a session assembling
 * that commit reads to know it is due.
 */
export interface SupersededTool {
  /** The tool that does this now, and that the old one's answer names. */
  readonly supersededBy: string
  /** Not before this date, ISO 8601. A note to whoever removes it, not a timer. */
  readonly removeAfter: string
}

/**
 * The names that answer without being offered.
 *
 * **A list rather than a convention**, so that the set is readable in one place
 * by whoever eventually removes it, and so that a test can assert the whole of
 * it rather than the examples somebody remembered.
 */
export const SUPERSEDED_TOOLS: Readonly<Record<string, SupersededTool>> = {
  'kolonie.accounts.status': { supersededBy: 'kolonie.accounts.set', removeAfter: '2026-09-13' },
  'kolonie.accounts.note': { supersededBy: 'kolonie.accounts.set', removeAfter: '2026-09-13' },
  'kolonie.accounts.vault-key': { supersededBy: 'kolonie.accounts.set', removeAfter: '2026-09-13' },
  'kolonie.accounts.provider': { supersededBy: 'kolonie.accounts.set', removeAfter: '2026-09-13' },
  'kolonie.accounts.prefer': { supersededBy: 'kolonie.accounts.set', removeAfter: '2026-09-13' },
  'kolonie.accounts.for-work': { supersededBy: 'kolonie.accounts.set', removeAfter: '2026-09-13' },
  'kolonie.accounts.attestable': {
    supersededBy: 'kolonie.accounts.set',
    removeAfter: '2026-09-13',
  },
  'kolonie.accounts.on-profile': {
    supersededBy: 'kolonie.accounts.set',
    removeAfter: '2026-09-13',
  },
}

/** Whether a tool is one of the superseded names. */
export const isSuperseded = (name: string): boolean =>
  Object.hasOwn(SUPERSEDED_TOOLS, name) && SUPERSEDED_TOOLS[name] !== undefined

/** One line for the end of a superseded tool's answer, naming where it went. */
export const movedTo = (name: string): string => {
  const entry = SUPERSEDED_TOOLS[name]

  return entry === undefined
    ? ''
    : `\n\nThis is now one field of ${entry.supersededBy}, which sets any of them in one call. ` +
        `${name} still answers and is no longer listed; use ${entry.supersededBy} from here.`
}

/** A `tools/list` result with the superseded names removed, or the message untouched. */
const withoutSuperseded = (message: JSONRPCMessage): JSONRPCMessage => {
  if (!('result' in message) || message.result === undefined) return message

  const result = message.result as Record<string, unknown>
  const tools = result['tools']
  if (!Array.isArray(tools)) return message

  return {
    ...message,
    result: {
      ...result,
      tools: tools.filter((tool) => {
        const name = (tool as { name?: unknown }).name
        return typeof name !== 'string' || !isSuperseded(name)
      }),
    },
  } as JSONRPCMessage
}

/**
 * Stop offering the superseded names on every list this server will answer.
 *
 * Called once by `createMcpServer`, beside `publishLeanSchemas`, so nothing an
 * author of a new tool does or forgets can opt out of it.
 */
export function hideSupersededTools(server: McpServer): void {
  const connect = server.connect.bind(server)

  server.connect = async (transport: Transport, ...rest: unknown[]): Promise<void> => {
    const send = transport.send.bind(transport)
    transport.send = (message, options) => send(withoutSuperseded(message), options)
    return connect(transport, ...(rest as []))
  }
}
