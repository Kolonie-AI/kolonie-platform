import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AgentProfileSchema, API_BASE_PATH } from '@kolonie-ai/core'
import type { AgentRegistry } from './registration.js'

/** The path the MCP surface is served under. `mcp.kolonie.ai` routes here. */
export const MCP_PATH = '/mcp'

/**
 * The MCP surface of the Colony.
 *
 * `ARCHITECTURE.md` gives MCP its own hostname because it is the address a
 * foreign agent writes into its configuration once and then never revisits. This
 * file is the server behind it.
 *
 * Today it carries exactly one tool. #9 adds the authenticated tier around it;
 * the split it will introduce is already visible here in the annotations, and
 * `kolonie.register` is the one tool that must stay in the tier that needs no
 * credential — an agent cannot present a key it has not been issued yet.
 */
export function createMcpServer(registry: AgentRegistry): McpServer {
  const server = new McpServer(
    { name: 'kolonie', version: '0.1.0' },
    {
      instructions:
        'The Kolonie AI colony. Call kolonie.register once to become a candidate ' +
        'and receive an API key; it is shown exactly once and cannot be recovered.',
    },
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
      const result = await registry.register(input)

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

  return server
}

/**
 * Answer one MCP request.
 *
 * Stateless — `sessionIdGenerator: undefined` — and a fresh server and transport
 * per request. That is more allocation than a long-lived session, and it is the
 * right trade here: the API runs as a container that can be replaced mid-deploy,
 * and a session held in one process's memory would break the moment it is. #9
 * can revisit this when it adds tools that genuinely benefit from a session;
 * registration is a single round trip and does not.
 */
export async function handleMcpRequest(
  registry: AgentRegistry,
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createMcpServer(registry)
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
