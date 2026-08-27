import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ERROR_STATUS } from '@kolonie-ai/core'
import { TOOL_DOCS, TOOL_DOCS_PATH } from '../mcp/tool-docs.js'
import { attributeTo } from '../call-rollup.js'
import { authenticate } from '../authentication.js'
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
 * issue asked for. Nothing **served** here varies by caller and nothing served
 * here is a fact about anybody; attribution is a response-side count and never
 * part of the answer.
 *
 * ## `text/markdown`, not JSON
 *
 * The reader is a model. What it wants is the prose, and wrapping prose in a
 * JSON envelope buys nothing but escaping — the same reasoning `/llms.txt` in
 * `kolonie-website` gives for being plain text rather than a document tree.
 *
 * ## Countable, and exactly as far as attribution reaches (`#1718`)
 *
 * See {@link attributeDocsFetch} below for what is counted and — the part that
 * matters more — what is not.
 */
export function registerToolDocsRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  /**
   * Count this fetch against a citizen, where one happens to have identified
   * itself (`#1718`).
   *
   * ## What this is
   *
   * `registerCallRollup`'s response hook writes a row only for a request it can
   * attribute, and `attributeTo` was called from exactly three places: the
   * authenticated route wrapper, `/v1/agents/me`, and the not-found hook in
   * `app.ts` when an `authorization` header was presented. This route
   * authenticates nothing, so it reached none of them — and a fetch could
   * therefore produce no row however many citizens made one. Measured over the
   * seven days to 2026-08-26, `agent_call_hours` held **zero** rows for
   * `/v1/tools/:name` in a window where it recorded 3,614 tool calls, which made
   * the relocation's benefit unfalsifiable rather than unproven.
   *
   * **This is the not-found hook's rule, on this route.** Same condition — an
   * `authorization` header was presented — same discarded outcome, same absence
   * of any new disclosure. It is deliberately not a second counting mechanism
   * beside the rollup, which `#835` kept narrow on purpose.
   *
   * ## What it does not see, which is the limitation to know before reading the
   * counts
   *
   * **An anonymous fetch is invisible here and always will be.** A client that
   * follows `_meta` without sending a key produces no row, exactly as it did
   * before this existed, so these numbers are a floor and never a total. Read a
   * zero as *no credentialed client fetched this*, never as *nobody did*.
   *
   * That is a real cost and it was accepted for a reason: the question the
   * counts have to answer is whether **any credentialed** client follows `_meta`
   * at all, and a non-zero count settles that. A counter that saw every fetch
   * would answer more fully and would be a second mechanism with no citizen on
   * it; it is written down here rather than discovered later by whoever reads
   * the counts. `docs/decisions/D-143` records the choice.
   *
   * ## What it is not
   *
   * **Not a credential requirement.** Nothing above this line changes: the
   * documentation is served identically whether a key was presented, absent,
   * malformed or revoked, and this runs beside that answer rather than in front
   * of it. The relocation was built on reading documentation needing no
   * credential and that property is untouched.
   *
   * **Not an oracle.** The response is byte-identical either way, so a caller
   * cannot learn from one whether its key resolved.
   *
   * **No citizen is identifiable in the counts.** The underlying
   * `agent_call_hours` record already belongs to one citizen, as every other
   * route's does; nothing new is collected there. The measurement reader
   * `routeTalliesSince` groups those rows by route and returns only the number
   * of citizens in the bucket, never an id, name or handle. And the route
   * template is `/v1/tools/:name` for every tool, so which documentation was
   * read is absent even from the underlying record.
   */
  const attributeDocsFetch = async (request: FastifyRequest): Promise<void> => {
    if (deps.rollup === undefined || request.headers.authorization === undefined) return

    const authenticated = await authenticate(request.headers.authorization, deps.store)
    if (authenticated.outcome === 'authenticated') attributeTo(request, authenticated.agent.id)
  }

  /**
   * The index, so an agent that has the origin and not a tool name can look.
   *
   * Derived from `TOOL_DOCS` rather than listed, which is the rule `/llms.txt`
   * states for itself: a hand-written index is wrong the first time an entry is
   * added, and nothing says so.
   */
  v1.get(TOOL_DOCS_PATH, async (request) => {
    await attributeDocsFetch(request)

    return {
      tools: Object.keys(TOOL_DOCS).sort(),
      notice:
        'The long form of a tool description: how to fill it in, worked examples, and why it ' +
        'is built the way it is. What decides whether to call a tool at all stays in the tool ' +
        'description itself and is not repeated here.',
    }
  })

  v1.get<{ Params: { name: string } }>(`${TOOL_DOCS_PATH}/:name`, async (request, reply) => {
    await attributeDocsFetch(request)

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
