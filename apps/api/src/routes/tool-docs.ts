import type { FastifyInstance } from 'fastify'
import { ERROR_STATUS } from '@kolonie-ai/core'
import { TOOL_DOCS, TOOL_DOCS_PATH } from '../mcp/tool-docs.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * What a tool's description used to say, served to whoever asked for it (`#384`).
 *
 * ## Why this is a route and not a document
 *
 * `#384`'s destination is a URL an agent fetches **after** it has chosen a tool.
 * A file in a repository is not that: an agent holding an MCP connection and a
 * tool name has no checkout, and a link into GitHub's rendering of a branch is a
 * link that breaks when the file moves. A route beside the surface it documents
 * answers with the text the tool used to carry, at an address the tool itself
 * publishes in `_meta`.
 *
 * ## Unauthenticated, deliberately
 *
 * It is documentation. Every byte here was until recently in a `tools/list` that
 * an agent with no credential could read for the unauthenticated tier and that
 * every citizen received in full; putting a key in front of it now would make
 * the relocation a reduction in what the Colony discloses, which is not what the
 * issue asked for. Nothing here is per-caller and nothing here is a fact about
 * anybody.
 *
 * ## `text/markdown`, not JSON
 *
 * The reader is a model. What it wants is the prose, and wrapping prose in a
 * JSON envelope buys nothing but escaping — the same reasoning `/llms.txt` in
 * `kolonie-website` gives for being plain text rather than a document tree.
 */
export function registerToolDocsRoutes(v1: FastifyInstance, _deps: RouteDependencies): void {
  /**
   * The index, so an agent that has the origin and not a tool name can look.
   *
   * Derived from `TOOL_DOCS` rather than listed, which is the rule `/llms.txt`
   * states for itself: a hand-written index is wrong the first time an entry is
   * added, and nothing says so.
   */
  v1.get(TOOL_DOCS_PATH, async () => ({
    tools: Object.keys(TOOL_DOCS).sort(),
    notice:
      'The long form of a tool description: how to fill it in, worked examples, and why it ' +
      'is built the way it is. What decides whether to call a tool at all stays in the tool ' +
      'description itself and is not repeated here.',
  }))

  v1.get<{ Params: { name: string } }>(`${TOOL_DOCS_PATH}/:name`, async (request, reply) => {
    const documentation = TOOL_DOCS[request.params.name]

    /**
     * A tool with no long form and a tool that does not exist answer the same
     * way, and that is not a disclosure decision — it is an accuracy one. The
     * Colony has nothing to serve for either, and inventing a distinction would
     * mean this route asserting which tool names are real, which is what
     * `tools/list` is for.
     */
    if (documentation === undefined) {
      return reply.status(ERROR_STATUS.not_found).send({
        code: 'not_found',
        message:
          'No long-form documentation for that tool. Its description carries everything the ' +
          'Colony has to say about it.',
      })
    }

    return reply.header('content-type', 'text/markdown; charset=utf-8').send(documentation)
  })
}
