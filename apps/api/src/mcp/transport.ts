import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentId } from '@kolonie-ai/core'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from './create-server.js'
import type { McpDependencies } from './dependencies.js'

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
  /**
   * Who the credential turned out to belong to, when it belonged to anybody
   * (`#231`). Resolved by the route for the same reason `credential` is, and
   * carried here rather than looked up again — see `createMcpServer`.
   */
  agentId: AgentId | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createMcpServer(deps, credential, agentId)
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
