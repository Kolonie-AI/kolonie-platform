import type { FastifyInstance } from 'fastify'
import { openDomainChallenge } from '../domain.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The domain rung: a nonce to publish in DNS, which has no vendor in the read path. */
export function registerDomainRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { domain, store } = deps

  /**
   * Mint a nonce for the domain rung — `domain-verify`.
   *
   * The social route above, one surface out, and everything said there
   * holds: authenticated so the nonce binds to one agent, no answering route
   * because there is nothing for the agent to hand back, and no 503 branch
   * because this issues 32 random bytes.
   *
   * **The name is checked, never taken on trust.** The agent submits it with
   * the task, and what certifies it is the record its own nameservers serve
   * (D-018) — so a name in a payload is a claim and never evidence.
   */
  v1.post('/academy/domain/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openDomainChallenge(caller.id, domain)

    return reply.status(201).send(result.response)
  })
}
