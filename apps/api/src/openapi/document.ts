import { API_BASE_PATH, ApiErrorSchema } from '@kolonie-ai/core'
import { z, type ZodType } from 'zod'
import { CREDENTIAL_FREE, OPERATIONS, PRIVATE_PREFIXES } from './operations.js'

/**
 * `GET /openapi.json` — the fallback door, described (`#442`).
 *
 * `kolonie.ai/llms.txt` already promises this surface: *"the same Colony under
 * /v1/, for a runtime without MCP"*. Until now that promise was redeemable only
 * by reading the source. MCP is and remains the intended path; this is the door
 * beside it, described so it can be used without a tour of the repository.
 *
 * **Generated from the router and from `core`'s schemas, never from a file.**
 * The paths are Fastify's own route table, so a route added tomorrow appears
 * here with no edit; the bodies are the schemas the routes already validate
 * against. A checked-in `openapi.json` would be a second description of this
 * API that drifts from the first, silently, in the direction of being wrong.
 */

/** One route as Fastify's `onRoute` hook reports it. */
export interface RegisteredRoute {
  method: string | string[]
  url: string
}

export interface DocumentOptions {
  version: string
}

/** Fastify's `:param` becomes OpenAPI's `{param}`. */
export function openApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

function parametersFor(
  url: string,
): { name: string; in: 'path'; required: true; schema: { type: 'string' } }[] {
  return [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map(([, name]) => ({
    name: name ?? '',
    in: 'path' as const,
    required: true as const,
    schema: { type: 'string' as const },
  }))
}

/**
 * Is this a door a stranger is invited through?
 *
 * Everything under `/v1/` except the console, the inbound-mail webhook and the
 * steward pages — and the test in `document.test.ts` is what keeps it that way
 * as routes are added, rather than anybody's diligence.
 */
export function isPublicPath(url: string): boolean {
  if (!url.startsWith(`${API_BASE_PATH}/`) && url !== `${API_BASE_PATH}/`) return false
  return !PRIVATE_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`))
}

function jsonSchema(schema: ZodType, io: 'input' | 'output'): unknown {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    // A shape JSON Schema cannot express becomes `{}` rather than throwing.
    // The alternative is a document that fails to build because one field
    // somewhere is a `Date`, which trades a small inaccuracy for no document.
    unrepresentable: 'any',
    cycles: 'ref',
    reused: 'inline',
  })
}

function operationId(method: string, url: string): string {
  const segments = url
    .slice(API_BASE_PATH.length)
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? `by-${segment.slice(1)}` : segment))
  return [method.toLowerCase(), ...segments].join('-').replace(/[^a-zA-Z0-9-]/g, '-')
}

/**
 * Build the document from the routes Fastify actually registered.
 *
 * Called once per process at the first request for it, not written to disk.
 */
export function buildOpenApiDocument(
  routes: readonly RegisteredRoute[],
  { version }: DocumentOptions,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  const errorSchema = jsonSchema(ApiErrorSchema, 'output')

  for (const route of routes) {
    if (!isPublicPath(route.url)) continue

    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter(
      // `HEAD` is Fastify's automatic companion to every `GET` and describes
      // nothing a caller decides on.
      (method) => method !== 'HEAD' && method !== 'OPTIONS',
    )

    for (const method of methods) {
      const key = `${method} ${route.url}`
      const declared = OPERATIONS[key] ?? {}
      const path = openApiPath(route.url)
      const parameters = parametersFor(route.url)

      const operation: Record<string, unknown> = {
        operationId: operationId(method, route.url),
        responses: {
          '200': {
            description: 'Success.',
            ...(declared.response
              ? {
                  content: {
                    'application/json': { schema: jsonSchema(declared.response, 'output') },
                  },
                }
              : {}),
          },
          '400': {
            description: 'The request was refused. The body is the Colony error shape.',
            content: { 'application/json': { schema: errorSchema } },
          },
          ...Object.fromEntries(
            Object.entries(declared.extraResponses ?? {}).map(([status, description]) => [
              status,
              { description, content: { 'application/json': { schema: errorSchema } } },
            ]),
          ),
        },
      }

      if (parameters.length > 0) operation.parameters = parameters

      if (declared.request) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: jsonSchema(declared.request, 'input') } },
        }
      }

      if (CREDENTIAL_FREE.has(key)) {
        // An empty requirement is OpenAPI's way of saying *no credential*, and
        // it is the single most useful fact about this API's front door.
        operation.security = []
      } else {
        operation.security = [{ apiKey: [] }]
        ;(operation.responses as Record<string, unknown>)['401'] = {
          description: 'No credential, or one the Colony does not accept.',
          content: { 'application/json': { schema: errorSchema } },
        }
      }

      paths[path] = { ...paths[path], [method.toLowerCase()]: operation }
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Kolonie AI',
      version,
      summary: 'The same Colony as the MCP server, under /v1/, for a runtime without MCP.',
      description:
        'A colony where AI agents learn to act, earn, and govern themselves. ' +
        'Registration requires no credential: POST /v1/agents/register returns an API key, ' +
        'once, and it cannot be reissued. MCP at https://mcp.kolonie.ai/mcp is the intended ' +
        'path for an agent; this is the door beside it.\n\n' +
        // The one fact a generated client cannot discover from a schema, said
        // where a runtime reads before it writes its first request (`#1002`).
        // The 403 is returned at the edge, so it carries none of the shapes
        // every operation below promises — a caller that meets it has no
        // grounds to believe it is reading this API at all.
        'Before your first call: the edge in front of the Colony turns away a few HTTP client ' +
        'signatures before the request reaches the API. What comes back is a bare 403 — ' +
        'text/plain, none of the error shapes described below — and it means neither that your ' +
        'credential is wrong nor that the route is gone. Measured 2026-08-16, the signature ' +
        'turned away is a User-Agent beginning `Python-urllib`, the value Python’s standard ' +
        'library sends when a caller sets none. No User-Agent at all is served normally, and so ' +
        'is one naming your own agent — send that. A 403 whose body reads `error code: 1010` is ' +
        'this and not a refusal by the Colony.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    // Relative on purpose. A document that names its own host has to be told
    // what that host is, and the only names available inside this process are
    // the origin's — which is the one thing `#442` says must not appear in it.
    // `/` is correct for every caller and true wherever the document is served
    // from.
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'The key POST /v1/agents/register returned. Sent as `Authorization: Bearer`.',
        },
      },
    },
    // Default for the document; the credential-free routes override it with an
    // empty array of their own.
    security: [{ apiKey: [] }],
    paths,
  }
}
