import { ProfessionDefinitionSchema, ProfessionKeySchema } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RouteDependencies } from './dependencies.js'
import type { ConsolePageContext } from './console-page-context.js'
import { backendProfessionsPage, backendProfessionVersionPage } from '../console/backend.js'
import { html, navFor, wantsHtml } from './console-shared.js'

const PublishBodySchema = z
  .object({
    expectedVersion: z.number().int().positive().nullable(),
    definition: ProfessionDefinitionSchema,
  })
  .strict()
const RetireBodySchema = z.object({ expectedVersion: z.number().int().positive() }).strict()

/** Registers the only routes that may publish or retire a profession definition. */
export function registerProfessionRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
  ctx: ConsolePageContext,
): void {
  if (deps.professions === undefined) return
  const professions: NonNullable<RouteDependencies['professions']> = deps.professions
  const { maintainer } = ctx

  app.get('/backend/professions', async (request, reply) => {
    if ((await maintainer(request, reply)) === null) return reply
    const listed = await professions.listForMaintainer()
    return wantsHtml(request)
      ? html(
          reply,
          backendProfessionsPage({
            nav: navFor(request, ['maintainer']),
            professions: listed,
          }),
        )
      : reply.send(listed)
  })

  app.get<{ Params: { key: string; version: string } }>(
    '/backend/professions/:key/versions/:version',
    async (request, reply) => {
      if ((await maintainer(request, reply)) === null) return reply
      const key = ProfessionKeySchema.safeParse(request.params.key)
      const version = z.coerce.number().int().positive().safeParse(request.params.version)
      if (!key.success || !version.success)
        return reply.status(400).send({ code: 'validation_failed' })
      const found = await professions.read(key.data, version.data)
      if (found === null) return reply.status(404).send({ code: 'not_found' })
      return wantsHtml(request)
        ? html(
            reply,
            backendProfessionVersionPage({
              nav: navFor(request, ['maintainer']),
              publication: found,
            }),
          )
        : reply.send(found)
    },
  )

  app.post<{ Params: { key: string } }>('/backend/professions/:key', async (request, reply) => {
    const held = await maintainer(request, reply)
    if (held === null) return reply
    const key = ProfessionKeySchema.safeParse(request.params.key)
    const body = PublishBodySchema.safeParse(request.body)
    if (!key.success || !body.success || key.data !== body.data.definition.key) {
      return reply.status(400).send({ code: 'validation_failed' })
    }
    const result = await professions.publish({ ...body.data, publisherId: held.id })
    if (result.outcome === 'published') return reply.send(result)
    return reply.status(result.outcome === 'conflict' ? 409 : 422).send(result)
  })

  app.post<{ Params: { key: string } }>(
    '/backend/professions/:key/retire',
    async (request, reply) => {
      if ((await maintainer(request, reply)) === null) return reply
      const key = ProfessionKeySchema.safeParse(request.params.key)
      const body = RetireBodySchema.safeParse(request.body)
      if (!key.success || !body.success)
        return reply.status(400).send({ code: 'validation_failed' })
      const result = await professions.retire({
        key: key.data,
        expectedVersion: body.data.expectedVersion,
      })
      if (result.outcome === 'retired') return reply.send(result)
      return reply.status(result.outcome === 'conflict' ? 409 : 422).send(result)
    },
  )
}
