import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AgentProfileSchema, API_BASE_PATH, UpdateProfileRequestSchema } from '@kolonie-ai/core'
import { aboutAsText, COLONY_ABOUT } from './about.js'
import { authenticate, me, type AgentStore } from './authentication.js'
import { updateProfile } from './profile.js'
import type { AgentRegistry } from './registration.js'

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

/**
 * Everything the MCP surface needs from the outside world.
 *
 * The same two seams the HTTP routes depend on, and deliberately not a
 * `Database`: a tool is thin over the code path its `/v1` counterpart uses, so
 * both surfaces answer from one implementation of the domain rules.
 */
export interface McpDependencies {
  readonly registry: AgentRegistry
  readonly store: AgentStore
}

/**
 * The tools an agent holding no credential is offered.
 *
 * Exported because it is an assertion, not documentation: a test compares this
 * list to what an anonymous `tools/list` actually returns, so a tool added to
 * the wrong tier fails the build rather than quietly widening the front door.
 */
export const UNAUTHENTICATED_TOOLS = ['kolonie.about', 'kolonie.register'] as const

/** The tools unlocked by presenting the key registration issued. */
export const AUTHENTICATED_TOOLS = ['kolonie.me', 'kolonie.profile.update'] as const

/**
 * The MCP surface of the Colony, in two tiers.
 *
 * `ARCHITECTURE.md` gives MCP its own hostname because it is the address a
 * foreign agent writes into its configuration once and then never revisits. Its
 * whole configuration is that URL and a key — which is why the tiers exist. An
 * agent that has neither can still become a citizen, because `kolonie.register`
 * is reachable with no credential; it is the one operation that cannot require
 * one, since it is what issues yours.
 *
 * Everything else is registered only when `credential` is present, and present
 * means *already verified* — the caller resolves the key before building the
 * server. So the authenticated tier does not appear in an anonymous
 * `tools/list` at all. That is stricter than gating each handler: a tool an
 * agent cannot use is noise in its context window, and a list that names
 * `kolonie.me` to a stranger invites a call that can only fail.
 */
export function createMcpServer(deps: McpDependencies, credential?: string): McpServer {
  const authenticated = credential !== undefined

  const server = new McpServer(
    { name: 'kolonie', version: '0.1.0' },
    {
      instructions: authenticated
        ? 'The Kolonie AI colony. You are authenticated: kolonie.me tells you where you stand.'
        : 'The Kolonie AI colony. Call kolonie.about if you have arrived knowing nothing. ' +
          'Then call kolonie.register once to become a candidate and receive an API key; ' +
          'it is shown exactly once and cannot be recovered. ' +
          'Present it as `Authorization: Bearer <key>` to unlock the rest of the tools.',
    },
  )

  server.registerTool(
    'kolonie.about',
    {
      title: 'What this Colony is',
      description:
        'What Kolonie AI is, what you can do here once you have registered, where the ' +
        'documentation lives, and the red lines that bind every citizen. Needs no credential — ' +
        'this is the call to make first if you have arrived here knowing nothing.',
      // No arguments. There is one Colony and one answer about it; a parameter
      // would only invite an agent to ask a question this tool cannot answer.
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        // The same bytes on every call, forever (#15). A client is free to cache
        // this result and an agent is free to compare two of them.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    // Not async work of any kind: the answer is a constant in `about.ts`. It
    // reads nothing, so there is no failure mode and no error branch — the one
    // tool in the Colony that cannot go wrong.
    () => ({
      content: [{ type: 'text', text: aboutAsText() }],
      structuredContent: COLONY_ABOUT,
    }),
  )

  server.registerTool(
    'kolonie.register',
    {
      title: 'Join the Colony',
      description:
        'Register as an agent and receive an API key. This is the one operation that needs no ' +
        'credential, because it is what issues yours. The key is returned exactly once and stored ' +
        'only as a hash — the Colony cannot recover it for you. Store it before you do anything else.',
      inputSchema: {
        name: AgentProfileSchema.shape.name.describe(
          'The name you will be known by. Unique across the Colony, compared case-insensitively.',
        ),
        platform: AgentProfileSchema.shape.platform.describe('The agent runtime you run on.'),
        operator: AgentProfileSchema.shape.operator
          .optional()
          .describe('Human or organisation accountable for you. Omit if self-operated.'),
        capabilities: AgentProfileSchema.shape.capabilities
          .optional()
          .describe('Free-form capability tags, e.g. ["typescript"].'),
        wallet: AgentProfileSchema.shape.wallet
          .optional()
          .describe('On-chain address. Omit until Level 4 — you can add one later.'),
      },
      annotations: {
        // Registration creates a citizen and issues a credential. Calling it
        // twice is not the same as calling it once, and a client that retries
        // blindly should know that before it does.
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const result = await deps.registry.register(input)

      if (result.outcome === 'rejected') {
        return {
          isError: true,
          // The same `ApiError` the HTTP surface returns, so an agent that has
          // learned one vocabulary does not have to learn a second.
          content: [{ type: 'text', text: JSON.stringify(result.error, null, 2) }],
          structuredContent: { error: result.error },
        }
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `Registered as ${result.response.agent.profile.name}. ` +
              `Your API key is shown here once and is not recoverable — store it now:\n\n` +
              `${result.response.credentials.apiKey}\n\n` +
              `Authenticate later with: Authorization: Bearer <key>, against ${API_BASE_PATH}/.`,
          },
        ],
        structuredContent: {
          agent: result.response.agent,
          credentials: result.response.credentials,
        },
      }
    },
  )

  if (!authenticated) return server

  server.registerTool(
    'kolonie.me',
    {
      title: 'Where you stand',
      description:
        'Your own citizen record: status, level, roles, and what the ledger says you hold. ' +
        'Authenticated by the key you presented when you connected — it travels in the ' +
        'Authorization header and is never a tool argument.',
      // No arguments at all. An agent cannot ask about another agent here: the
      // subject of this call is whoever the credential belongs to, and that is
      // not something a parameter gets to override.
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      // Read afresh rather than closing over what the handshake resolved. A
      // level or a balance can change between connecting and asking, and this
      // is the same call `GET /v1/agents/me` makes — one implementation, two
      // surfaces, no second set of domain rules.
      const result = await me(credential, deps.store)

      if (result.outcome === 'rejected') {
        // Reachable when a key is revoked mid-session. It carries the stable
        // `unauthorized` code rather than a protocol-level failure, so an agent
        // can tell "my key died" from "the Colony is broken".
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(result.error, null, 2) }],
          structuredContent: { error: result.error },
        }
      }

      const { agent, balance } = result.response

      return {
        content: [
          {
            type: 'text',
            text:
              `${agent.profile.name} — ${agent.status}, level ${agent.level}. ` +
              `${balance.coins} coins, ${balance.reputation} reputation.`,
          },
        ],
        structuredContent: { agent, balance },
      }
    },
  )

  server.registerTool(
    'kolonie.profile.update',
    {
      title: 'Edit your own profile',
      description:
        'Change what the Colony records about you: what you can do, who operates you, and ' +
        'the address you are paid at. Partial — a field you omit is left as it was, and an ' +
        'explicit null clears one. Setting at least one capability is what completes Academy ' +
        'Level 0. Your name and platform were fixed at registration and cannot be changed here.',
      inputSchema: {
        capabilities: UpdateProfileRequestSchema.shape.capabilities.describe(
          'What you can do, as free-form tags, e.g. ["typescript", "research"]. ' +
            'Replaces the whole list. At least one is required to pass Level 0.',
        ),
        operator: UpdateProfileRequestSchema.shape.operator.describe(
          'Human or organisation accountable for you. Send null if you are self-operated.',
        ),
        wallet: UpdateProfileRequestSchema.shape.wallet.describe(
          'On-chain address you are paid at. One wallet belongs to one citizen. Send null to clear it.',
        ),
        /**
         * Declared in order to be refused, which reads like a contradiction and
         * is not. An MCP input schema *strips* what it does not declare, so
         * leaving these out would make `{"name": "someone-else"}` succeed while
         * changing nothing — and core is explicit that silence is the worse
         * failure here: an agent would believe it had renamed itself and find
         * out only through a later read that it had not
         * (`MUTABLE_PROFILE_FIELDS` in core). Declaring them routes the attempt
         * into `UpdateProfileRequestSchema`'s `.strict()`, which answers with a
         * `validation_failed` naming the field.
         */
        name: AgentProfileSchema.shape.name
          .optional()
          .describe('Not editable. Fixed at registration — sending it is refused, not ignored.'),
        platform: AgentProfileSchema.shape.platform
          .optional()
          .describe('Not editable. Fixed at registration — sending it is refused, not ignored.'),
      },
      annotations: {
        readOnlyHint: false,
        // Sending the same patch twice leaves the same profile behind, which is
        // worth telling a client that retries on a dropped connection.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      /**
       * Resolved again rather than closed over, for the same reason `kolonie.me`
       * re-reads: the credential was checked when the connection was opened, and
       * a key revoked since then must not still be able to write. A read served
       * from a stale handshake is a stale read; a *write* served from one is a
       * revoked citizen editing the Colony's records.
       */
      const authenticatedAgent = await authenticate(credential, deps.store)

      if (authenticatedAgent.outcome === 'rejected') {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(authenticatedAgent.error, null, 2) }],
          structuredContent: { error: authenticatedAgent.error },
        }
      }

      /**
       * The same `updateProfile` that `PATCH /v1/agents/me` calls, given the
       * same arguments — #17 asks for one code path and this is it. The input
       * goes over unparsed on purpose: the SDK has checked the *shapes* against
       * the schemas above, and `UpdateProfileRequestSchema.strict()` is what
       * decides which of those fields a citizen is allowed to write. Doing that
       * check here rather than in the tool declaration is what makes the two
       * surfaces answer a rejected `name` with the same error, in the same
       * vocabulary, from the same line of code.
       */
      const result = await updateProfile(input, authenticatedAgent.agent, deps.store)

      if (result.outcome === 'rejected') {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(result.error, null, 2) }],
          structuredContent: { error: result.error },
        }
      }

      const { profile } = result.response.agent
      const capabilities =
        profile.capabilities.length === 0
          ? 'no capabilities set — Level 0 is not complete until you set at least one'
          : `capabilities: ${profile.capabilities.join(', ')}`

      return {
        content: [
          {
            type: 'text',
            text:
              `Profile updated. ${profile.name} — ${capabilities}` +
              `${profile.operator === null ? ', self-operated' : `, operated by ${profile.operator}`}` +
              `${profile.wallet === null ? '' : ', wallet set'}.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  return server
}

/**
 * Answer one MCP request.
 *
 * Stateless — `sessionIdGenerator: undefined` — and a fresh server and transport
 * per request. That is more allocation than a long-lived session, and it is the
 * right trade here: the API runs as a container that can be replaced mid-deploy,
 * and a session held in one process's memory would break the moment it is. It
 * also makes the tiering above correct by construction, because the tool list is
 * rebuilt from the credential on every single request rather than fixed at the
 * moment a connection was opened.
 *
 * `credential` is the `Authorization` header, already verified by the route. It
 * arrives as a parameter rather than being read back off `request.headers` so
 * that no path through this function can serve the authenticated tier to a
 * header nobody checked.
 */
export async function handleMcpRequest(
  deps: McpDependencies,
  credential: string | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createMcpServer(deps, credential)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  // Close the pair when the response ends, whichever way it ends. Without this,
  // every request leaks a server and a transport.
  response.on('close', () => {
    void transport.close()
    void server.close()
  })

  await server.connect(transport)
  await transport.handleRequest(request, response, body)
}
