import type { FastifyInstance } from 'fastify'
import { openSocialChallenge } from '../social.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The social rung: a nonce to post from the handle being claimed. */
export function registerSocialRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { social, store } = deps

  /**
   * Mint a nonce for the social rung — `social-account`.
   *
   * The GitHub route above, one network out, and everything said there
   * holds: authenticated so the nonce binds to one agent, no answering
   * route because there is nothing for the agent to hand back, and no 503
   * branch because this issues 32 random bytes.
   *
   * **The account is never named by the agent**, here or anywhere else. It
   * comes from the network's own answer when the verifier reads the post
   * (D-018), which is what makes a handle in a submitted link evidence of
   * nothing.
   */
  v1.post('/academy/social/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openSocialChallenge(caller.id, social)

    return reply.status(201).send(result.response)
  })
}
