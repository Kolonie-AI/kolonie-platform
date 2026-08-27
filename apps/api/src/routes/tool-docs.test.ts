import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { TOOL_DOCS, toolDocsUrl } from '../mcp/tool-docs.js'

let app: FastifyInstance

beforeEach(async () => {
  app = buildApp(fakeColony())
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

/**
 * The address a tool's `_meta` publishes (`#384`).
 *
 * The point of these is that the URL in the tool list is not a promise — it is
 * an address, and an address that answers `404` would be worse than leaving the
 * paragraph in the description where every citizen paid for it.
 */
describe('the long form of a tool description', () => {
  it('answers Markdown at the URL the tool publishes', async () => {
    for (const name of Object.keys(TOOL_DOCS)) {
      // The path the `_meta` URL names, taken from the URL itself rather than
      // rebuilt — this is the assertion that the two halves agree.
      const path = new URL(toolDocsUrl(name)).pathname

      const response = await app.inject({ method: 'GET', url: path })

      expect(response.statusCode, name).toBe(200)
      expect(response.headers['content-type']).toContain('text/markdown')
      expect(response.body).toContain(`# ${name}`)
    }
  })

  it('lists what it has, derived rather than typed', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/tools' })

    expect(response.statusCode).toBe(200)
    expect(response.json().tools).toEqual(Object.keys(TOOL_DOCS).sort())
  })

  /**
   * **The rejection case.** A tool with no long form and a name that is not a
   * tool answer identically — this route does not assert which tool names are
   * real, which is what `tools/list` is for.
   */
  it('refuses a tool it has nothing for, and one that does not exist, the same way', async () => {
    const noDocs = await app.inject({ method: 'GET', url: '/v1/tools/kolonie.me' })
    const noTool = await app.inject({ method: 'GET', url: '/v1/tools/kolonie.invented' })

    expect(noDocs.statusCode).toBe(404)
    expect(noTool.statusCode).toBe(404)
    expect(noDocs.body).toBe(noTool.body)
  })

  /** Documentation, and it was in an unauthenticated tool list until recently. */
  it('needs no credential', async () => {
    const response = await app.inject({
      method: 'GET',
      url: new URL(toolDocsUrl('kolonie.quests.write')).pathname,
    })

    expect(response.statusCode).toBe(200)
  })

  /**
   * **The property `#1718` must not regress, asserted against the change that
   * could have.** Attributing a fetch when a key happens to be presented
   * (D-143) runs beside the answer rather than in front of it: a malformed
   * credential is not a refusal here, because this is documentation and the
   * relocation was built on it needing no key. A route that had started
   * refusing one would fail here rather than in production.
   */
  it('serves the documentation whatever the Authorization header says', async () => {
    const url = new URL(toolDocsUrl('kolonie.quests.write')).pathname

    for (const authorization of ['Bearer not-a-key', 'nonsense', 'Bearer ']) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization } })

      expect(response.statusCode, authorization).toBe(200)
      expect(response.headers['content-type']).toContain('text/markdown')
    }
  })

  /** And the index, which answers the same question about the same surface. */
  it('serves the index whatever the Authorization header says', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tools',
      headers: { authorization: 'Bearer not-a-key' },
    })

    expect(response.statusCode).toBe(200)
  })
})
