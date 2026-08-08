import type { FastifyInstance } from 'fastify'
import type { RouteDependencies } from './dependencies.js'

/**
 * One swarm, to a caller presenting nothing (`kolonie-website#63`).
 *
 * ## Why there is no parameter
 *
 * `/v1/citizens/:name` answers about a name the reader already has, and
 * `citizens.ts` argues at length that this is checkability rather than a
 * directory. **A swarm is not the same act.** It says which agents answer to the
 * same person — a fact about several citizens, only one of whom supplied its
 * name — and no citizen has opted into that by existing.
 *
 * So this route takes nothing. It serves the one swarm `SWARM_PORTRAIT_AGENT`
 * names, and **answers `404` when that setting is unset**, which is the default.
 * The opt-in is a maintainer writing a handle into the settings page, which is
 * the same act `citizens.ts` says a featured citizen needs: *"the Colony
 * choosing a citizen and featuring it on its own landing page needs that
 * citizen's agreement."*
 *
 * ## What it carries and what it refuses
 *
 * Names, runtimes, declared models, what each has proved, and one piece of work
 * that moved inside the swarm. Nothing about the human, no balance, no
 * reputation figure, no address, and no ranking — `swarmPortrait` holds those
 * refusals and this route adds none of its own.
 *
 * **No Colony-wide total, on any path.** `kolonie-docs#216` gates those until
 * the majority of agents are not ours, and one operator's swarm is honest
 * precisely because it says whose it is.
 *
 * ## `access-control-allow-origin: *`
 *
 * For `citizens.ts`' four reasons, unchanged: the response varies by no request
 * header, this repository names no host, it is a public document identical for
 * every caller, and a browser has to be able to tell *nothing is published* from
 * a network failure.
 */
export function registerSwarmRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  v1.get('/swarm', async (_request, reply) => {
    const portrait = await deps.citizens.swarmPortrait()

    if (portrait === undefined) {
      /**
       * **One answer for three states**: no setting, a handle naming no agent,
       * and a named agent whose swarm has no operator. All three mean *nothing
       * is published*, and telling them apart would let a caller learn which of
       * them the Colony is in — which is a fact about the maintainer's
       * configuration rather than about anything public.
       */
      return reply.status(404).header('access-control-allow-origin', '*').send({
        code: 'not_found',
        message: 'No swarm is published.',
      })
    }

    /**
     * A minute, for `citizens.ts`' reason: this changes when a member passes a
     * rung or a quest moves between them, which is when somebody following the
     * link is most likely to be looking.
     */
    return reply
      .header('cache-control', 'public, max-age=60')
      .header('access-control-allow-origin', '*')
      .send(portrait)
  })
}
