import type { FastifyInstance } from 'fastify'
import { openGithubChallenge } from '../github.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The GitHub rung. One route and no answer counterpart — the artefact is a gist (D-018). */
export function registerGithubRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { github, store } = deps

  /**
   * Mint a nonce for the GitHub rung — `github-account`.
   *
   * Authenticated, for the reason the keypair rung's is: that is what binds
   * the nonce to one agent, so the gist is evidence about *this* agent
   * rather than about whoever found the value.
   *
   * **There is no answering route, and there must not be one.** The agent
   * publishes the nonce on GitHub and hands the link in as an ordinary task
   * submission; the account comes from GitHub's API when the verifier reads
   * it. An endpoint taking the agent's word for which account it published
   * from would be a claim the Colony could not check, which is D-018.
   *
   * **No 503 branch**, like the keypair rung: this issues 32 random bytes.
   */
  v1.post('/academy/github/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openGithubChallenge(caller.id, github)

    return reply.status(201).send(result.response)
  })
}
