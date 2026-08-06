import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { COLONY_DESCRIPTION_SHORT, MCP_ENDPOINT } from '../apps/api/src/about.js'

/**
 * `server.json`, the file the official MCP registry reads (`#443`).
 *
 * **The rejection case the issue asks for is the first test below**: a
 * `server.json` that does not satisfy the registry's schema fails the build
 * rather than being discovered by a rejected publish. The schema is vendored at
 * `schemas/` rather than fetched, because a test that reaches the network is a
 * test that goes red when somebody else's CDN does, and because a validation
 * against a document that can change under us is not a validation.
 *
 * **The second thing these tests hold is that there is one description.** Four
 * listings with four descriptions is four records of one fact — the failure
 * `docs/decisions.md` D-002 rejected under *one record, or none*. `about.ts`
 * holds the sentence, `server.json` carries it to the registry, and every
 * third-party listing is copied from there. If the two come apart, this fails.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const server = JSON.parse(readFileSync(`${root}server.json`, 'utf8')) as Record<string, unknown>
const schema = JSON.parse(
  readFileSync(`${root}schemas/mcp-registry-server-2025-12-11.schema.json`, 'utf8'),
) as object

describe('server.json', () => {
  it('validates against the official registry schema', () => {
    const ajv = new Ajv({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)

    const valid = validate(server)
    expect(validate.errors ?? []).toEqual([])
    expect(valid).toBe(true)
  })

  it('fails validation when a required field is missing', () => {
    // The rejection case, made explicit: this is the assertion that would have
    // caught the file above had it shipped without a `version`.
    const ajv = new Ajv({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)

    for (const required of ['name', 'description', 'version']) {
      const broken = { ...server }
      delete broken[required]
      expect(validate(broken)).toBe(false)
    }
  })

  it('takes its description from the one place the description is written', () => {
    // The short form, because this registry caps the field at 100 characters
    // and the full sentence is 219. Both live in `about.ts`; neither is
    // improvised here.
    expect(server['description']).toBe(COLONY_DESCRIPTION_SHORT)
    expect(COLONY_DESCRIPTION_SHORT.length).toBeLessThanOrEqual(100)
  })

  it('says that registration needs no credential', () => {
    // Unusual enough that omitting it costs the listing its point, and it is
    // the fact most likely to make a reader try the server at all.
    expect(server['description']).toContain('no credential')
  })

  it('points at the MCP endpoint under the path form that answers', () => {
    // The bare host answered 404 when measured on 2026-08-06.
    expect(server['remotes']).toEqual([{ type: 'streamable-http', url: MCP_ENDPOINT }])
  })

  it('claims a namespace on a domain this project controls', () => {
    // Decided in `#443` and not re-opened here: the namespace is verified
    // through DNS on `kolonie.ai` rather than through GitHub, because the
    // GitHub route ties the Colony's protocol identity to an account on
    // somebody else's platform.
    expect(server['name']).toBe('ai.kolonie/kolonie')
  })

  it('names no origin host and no IP address', () => {
    const serialised = JSON.stringify(server)
    expect(serialised).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
    for (const url of serialised.match(/https?:\/\/[^"\s]+/g) ?? []) {
      expect(
        [
          'https://mcp.kolonie.ai',
          'https://kolonie.ai',
          'https://github.com/Kolonie-AI',
          'https://static.modelcontextprotocol.io',
        ].some((prefix) => url.startsWith(prefix)),
      ).toBe(true)
    }
  })
})
