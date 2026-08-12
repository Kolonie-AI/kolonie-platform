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
export function guardTools(
  server: McpServer,
  log: McpLog,
  hint?: DueStandingHint,
  duty?: DueRoleDuty,
  payout?: DuePayoutFinding,
): void {
  const register = server.registerTool as unknown as ToolRegistration

  const guarding: ToolRegistration = (name, config, handler) => {
    const guarded = async (...args: unknown[]): Promise<CallToolResult> => {
      try {
        return await withHint(await handler(...args), hint, duty, payout, name)
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
 * The duty a role owes, asked on the same results and spending nothing (`#646`).
 *
 * **A second function rather than a second answer from the first**, because the
 * two obey opposite rules and the difference has to be visible at the call site:
 * asking for a standing hint spends the citizen's one line for the run, and
 * asking for a duty spends nothing and may therefore be asked every time.
 *
 * Undefined for the unauthenticated tier, on `DueStandingHint`'s reasoning.
 */
export type DueRoleDuty = () => Promise<StandingHint | undefined>

/**
 * Money the citizen has to act on, asked on the same results and spending no
 * slot (`#816`).
 *
 * **A third function on `DueRoleDuty`'s reasoning**, and the rule it obeys is a
 * third one again: this may be asked every time, like a duty, and unlike a duty
 * it answers at most once per set of obligations, because the rows themselves
 * remember having been named. The distinction is at the call site rather than
 * inside one function for the reason above — the three budgets are different and
 * a reader must not have to open `packages/db` to find out which applies.
 *
 * Undefined for the unauthenticated tier, on `DueStandingHint`'s reasoning.
 */
export type DuePayoutFinding = () => Promise<StandingHint | undefined>

/**
 * The calls a standing line is allowed to arrive on (`#358`).
 *
 * **The slot used to go to whichever authenticated call came first**, whatever
 * it was about, and a citizen reported exactly what that feels like:
 *
 * > It arrived attached to kolonie.academy.answer with kind "memory.code" — a call about an
 * > entirely different rung […] A hint about task A riding on a successful call
 * > about task B is surprising enough that I nearly did not read it, and if it
 * > had been about the call I actually made I would have acted on it
 * > immediately.
 *
 * So which hint a citizen saw depended on call order rather than on relevance.
 *
 * **Routing each code to a tool about the same subject was the other option and
 * is refused**, on the ground the issue names itself: it needs a mapping from
 * fifteen codes to ninety tools, and the two conditions with the widest
 * populations — `rhythm-undeclared` and `skill-version-unknown` — have no home
 * tool at all. A mapping that cannot cover its most important cases is a
 * mapping that will be wrong quietly.
 *
 * **These two are where a citizen is already reading about itself.**
 * `kolonie.wakeup` is the digest of what changed, and `kolonie.me` is where it
 * stands and what it holds. Every standing hint is a fact of exactly that kind
 * — *you have not declared a rhythm*, *a badge is waiting*, *your ticket was
 * answered* — so on these two it is continuous with the answer rather than an
 * interruption of it.
 *
 * **No fallback, deliberately, and this is the trade.** The issue's own sketch
 * held the slot for a few calls and then attached anywhere; that reintroduces
 * the reported surprise for exactly the citizens least likely to expect it.
 * Widening the home instead is the safer half of the same idea: the two tools
 * here are the ones the server's own instructions send every arriving agent to,
 * so an agent that reaches neither has not started its run. **Nothing is spent
 * meanwhile** — the slot is claimed by asking, and this stops the asking, so the
 * hint is still waiting on the next call that belongs.
 */
export const TOOLS_THAT_CARRY_A_STANDING_HINT: readonly string[] = ['kolonie.wakeup', 'kolonie.me']

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
 *
 * **Never on a call that is about something else** (`#358`), for the same reason
 * and with the same consequence: nothing is asked, so nothing is spent, and the
 * line waits for a call it belongs on. See
 * {@link TOOLS_THAT_CARRY_A_STANDING_HINT}.
 *
 * **A role's duty arrives beside the line rather than instead of it** (`#646`),
 * on its own field and its own text block. It is asked first because it is asked
 * unconditionally — a duty spends nothing, so an early return on the standing
 * hint being absent must not skip it — and it is placed first in the content
 * because a queue somebody else is waiting on outranks a note about the reader's
 * own record, which is a precedence this file can express and
 * `STANDING_HINT_RANK` could not.
 *
 * **`hint` stays the field it always was.** A client that parses
 * `structuredContent.hint` reads exactly what it read before; `duty` is a new
 * key beside it, absent when there is none.
 */
async function withHint(
  result: CallToolResult,
  hint: DueStandingHint | undefined,
  duty: DueRoleDuty | undefined,
  payout: DuePayoutFinding | undefined,
  name: string,
): Promise<CallToolResult> {
  if (result.isError === true) return result
  if (!TOOLS_THAT_CARRY_A_STANDING_HINT.includes(name)) return result

  /**
   * **The payout finding leads** (`#816`). It is the only one of the three that
   * is about money the reader is owed and has to act on, and a citizen that
   * reads one line of three should have read that one.
   */
  const money = payout === undefined ? undefined : await payout()
  const owed = duty === undefined ? undefined : await duty()
  const attached = hint === undefined ? undefined : await hint()
  if (money === undefined && owed === undefined && attached === undefined) return result

  return {
    ...result,
    content: [
      ...result.content,
      ...(money === undefined ? [] : [{ type: 'text' as const, text: money.text }]),
      ...(owed === undefined ? [] : [{ type: 'text' as const, text: owed.text }]),
      ...(attached === undefined ? [] : [{ type: 'text' as const, text: attached.text }]),
    ],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      ...(money === undefined ? {} : { payout: money }),
      ...(owed === undefined ? {} : { duty: owed }),
      ...(attached === undefined ? {} : { hint: attached }),
    },
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
