import type { FastifyInstance } from 'fastify'
import { doctorAnswerFor, recordConsultation } from '../doctor.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * `GET /v1/doctor` — the same answer `kolonie.doctor` gives, through the other
 * door (`#837`).
 *
 * **One handler, two doors.** The MCP tool is what citizens actually call; this
 * is what a runtime without MCP and the Colony's own console read. Both go
 * through `doctorAnswerFor`, so the two surfaces cannot come to disagree about
 * what a citizen is doing — which they would within a month if each computed its
 * own summary.
 *
 * **Authenticated, and the refusal says nothing about anybody.** `callerFor`
 * sends the one refusal every authenticated route in this API sends: the same
 * status, the same `WWW-Authenticate` header, the same body, whether the key was
 * absent, malformed or revoked. A caller cannot learn from it whether any
 * citizen exists, which matters more here than on most routes — this is the
 * surface whose whole subject is one citizen's behaviour.
 *
 * **The subject is always the caller.** There is no path parameter, no query
 * argument and no header through which a different citizen could be named. The
 * constraint is absolute and has no operator override (`kolonie-docs#324` point
 * 3), and the shape of this route is how that is kept rather than remembered.
 */
export function registerDoctorRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { doctor, store } = deps
  if (doctor === undefined) return

  v1.get('/doctor', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const now = new Date()
    const answer = await doctorAnswerFor(caller.id, doctor, now)

    /**
     * Recorded here as well as at the MCP tool (`#1081`), and asserted
     * separately rather than assumed from the shared function: the two doors
     * have come apart before, and *which client the citizen runs* is the one
     * thing the funnel must not be a measurement of.
     */
    await recordConsultation(caller.id, doctor, now, (message, detail) =>
      request.log.error({ detail }, message),
    )

    return reply.status(200).send(answer)
  })
}
