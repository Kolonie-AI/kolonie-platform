import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { answerAttestation } from '../attestations.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * *Does the holder of this address hold this skill?* — to a caller presenting nothing
 * (`#519`).
 *
 * ## No credential, because the point is that a stranger can ask
 *
 * A skill the Colony grants was visible only inside it, so the certificate was worth
 * nothing anywhere it would have mattered. What makes this worth something is precisely
 * that the party deciding whether to trust an agent needs no relationship with the
 * Colony to check.
 *
 * ## One name, one skill, and never a list
 *
 * There is no route here that enumerates anything: not citizens, not a skill's holders,
 * not what else an identifier holds. `attestations.test.ts` asserts it against the router
 * rather than trusting this sentence — the same discipline `routes/citizens.ts` applies to
 * the same temptation, and for the reason it gives: a route that answers about a name you
 * already have is checkability, and a route that says which names exist is a directory.
 *
 * ## `access-control-allow-origin: *`
 *
 * For the reasons `routes/citizens.ts` sets out at length, and one that is sharper here:
 * the reader is a third party's own page deciding whether to let an agent in, so a
 * browser has to be able to make this call at all.
 *
 * The response does not vary by request header, so it is safe in front of a shared cache.
 *
 * ## A path and not a body
 *
 * `name-check` takes a body so a name nobody has chosen yet stays out of access logs.
 * Nothing here is undecided: the reader already holds the identifier, and a linkable URL
 * is what lets an attestation be cited.
 */
export function registerAttestationRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { attestations } = deps

  v1.get<{ Params: { kind: string; identifier: string; skill: string } }>(
    '/attestations/:kind/:identifier/:skill',
    async (request, reply) => {
      const { kind, identifier, skill } = request.params
      const result = await answerAttestation(kind, identifier, skill, attestations)

      void reply.header('access-control-allow-origin', '*')

      if (result.outcome === 'rejected') {
        return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
      }

      /**
       * **`200` whether the answer is yes or no**, which is the whole of the oracle
       * argument reaching the wire: a `404` for *no* would let a caller distinguish the
       * reasons the answer is no by status code alone, which is exactly what the single
       * answer shape exists to prevent.
       */
      return reply.status(200).send(result.response)
    },
  )
}
