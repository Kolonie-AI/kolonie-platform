import { describe, expect, it } from 'vitest'
import { UNROUTED_ROUTE_KEY, type AgentId } from '@kolonie-ai/core'
import type { ObservedCall } from '@kolonie-ai/db'
import { buildApp } from './app.js'
import { FAKE_CALLER_IP, fakeColony } from './__fixtures__/colony/index.js'
import { connectedClient } from './__fixtures__/mcp.js'
import type { CallRollup } from './call-rollup.js'

/** What was counted, in the order it was counted. */
type Counted = { readonly agentId: AgentId; readonly call: ObservedCall }

const recordingRollup = () => {
  const counted: Counted[] = []
  const rollup: CallRollup = {
    record: async (agentId, call) => {
      counted.push({ agentId, call })
    },
  }
  return { rollup, counted }
}

/**
 * `onResponse` runs after the reply has gone to the socket and the write is not
 * awaited, so a test asserting on it has to let the microtask queue drain.
 * `app.inject` resolves on the response, which is one turn earlier.
 */
const settled = async () => {
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * The hourly call rollup, at both doors (`#835`).
 *
 * These tests are about the two things that would go wrong silently: a resolved
 * URL reaching the `route_key` column, which would quietly turn a rollup into a
 * request log, and a call going uncounted at one of the two doors, which would
 * make every finding about a citizen depend on which surface it happened to use.
 */
describe('the hourly call rollup', () => {
  const citizen = async () => {
    const colony = fakeColony()
    const { rollup, counted } = recordingRollup()
    const app = buildApp({ ...colony, rollup })
    await app.ready()

    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return {
      colony,
      app,
      counted,
      rollup,
      apiKey: registered.response.credentials.apiKey,
      agentId: registered.response.agent.id,
    }
  }

  describe('the HTTP door', () => {
    it('counts an authenticated call under its route template', async () => {
      const { app, counted, apiKey, agentId } = await citizen()

      await app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      await settled()

      expect(counted).toHaveLength(1)
      expect(counted[0]?.agentId).toBe(agentId)
      expect(counted[0]?.call.routeKey).toBe('/v1/agents/me')
      expect(counted[0]?.call.status).toBe(200)
      expect(counted[0]?.call.bytesOut).toBeGreaterThan(0)
    })

    /**
     * **The rejection case.** There is no citizen to attribute an unauthenticated
     * call to, and inventing one would make this a log of strangers rather than
     * a record about citizens. What arrives without a credential is Traefik's to
     * count.
     */
    it('counts nothing for a call that presented no credential', async () => {
      const { app, counted } = await citizen()

      await app.inject({ method: 'GET', url: '/v1/agents/me' })
      await settled()

      expect(counted).toEqual([])
    })

    /** A key that resolves to nobody is nobody, on the same reasoning. */
    it('counts nothing for a credential that does not resolve', async () => {
      const { app, counted } = await citizen()

      await app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: { authorization: 'Bearer not-a-key' },
      })
      await settled()

      expect(counted).toEqual([])
    })

    /**
     * **The second rejection case, and the one the whole table is shaped by.** A
     * citizen calling a route that does not exist lands in one bucket, whatever
     * path it invented — otherwise a misconfigured agent would write a row per
     * typo and choose this table's cardinality for us.
     */
    it('collects a citizen’s unknown paths into one bucket', async () => {
      const { app, counted, apiKey } = await citizen()

      for (const url of ['/v1/task/one', '/v1/task/two', '/v1/nonsense']) {
        await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${apiKey}` } })
      }
      await settled()

      expect(counted).toHaveLength(3)
      expect(counted.map((entry) => entry.call.routeKey)).toEqual([
        UNROUTED_ROUTE_KEY,
        UNROUTED_ROUTE_KEY,
        UNROUTED_ROUTE_KEY,
      ])
      expect(counted.every((entry) => entry.call.status === 404)).toBe(true)
    })

    /** A stranger's 404 is not attributed to anybody and costs no lookup. */
    it('counts nothing for an unknown path with no credential', async () => {
      const { app, counted } = await citizen()

      await app.inject({ method: 'GET', url: '/v1/nonsense' })
      await settled()

      expect(counted).toEqual([])
    })

    /**
     * The relocated teaching, countable at last (`#1718`).
     *
     * `/v1/tools/:name` authenticates nothing by design, so it reached none of
     * the three places that call `attributeTo` and a fetch could produce no row
     * however many citizens made one — measured as zero rows over seven days in
     * which the same table recorded 3,614 tool calls. The route now applies the
     * not-found hook's rule: attribute where a key happens to be presented.
     */
    it('counts a docs fetch that presented a credential, under the route template', async () => {
      const { app, counted, apiKey, agentId } = await citizen()

      const response = await app.inject({
        method: 'GET',
        url: '/v1/tools/kolonie.quests.write',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      await settled()

      expect(response.statusCode).toBe(200)
      expect(counted).toHaveLength(1)
      expect(counted[0]?.agentId).toBe(agentId)
      // The template, so which documentation was read is not in the table.
      expect(counted[0]?.call.routeKey).toBe('/v1/tools/:name')
      expect(counted[0]?.call.status).toBe(200)
    })

    /** The index answers the same question and is counted the same way. */
    it('counts a fetch of the index too', async () => {
      const { app, counted, apiKey } = await citizen()

      await app.inject({
        method: 'GET',
        url: '/v1/tools',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      await settled()

      expect(counted).toHaveLength(1)
      expect(counted[0]?.call.routeKey).toBe('/v1/tools')
    })

    /**
     * **The rejection case, and the limitation D-143 exists to write down.** An
     * anonymous fetch produces no row, so these counts are a floor and never a
     * total: a zero means no credentialed client fetched this, never that
     * nobody did.
     */
    it('counts nothing for a docs fetch that presented no credential, and serves it anyway', async () => {
      const { app, counted } = await citizen()

      const response = await app.inject({ method: 'GET', url: '/v1/tools/kolonie.quests.write' })
      await settled()

      expect(response.statusCode).toBe(200)
      expect(counted).toEqual([])
    })

    /**
     * A key that resolves to nobody is nobody — the outcome is discarded, on
     * the same rule the not-found hook follows. The documentation is served
     * regardless, which is what keeps this from being a credential requirement.
     */
    it('serves the documentation and counts nothing when the credential does not resolve', async () => {
      const { app, counted } = await citizen()

      const response = await app.inject({
        method: 'GET',
        url: '/v1/tools/kolonie.quests.write',
        headers: { authorization: 'Bearer not-a-key' },
      })
      await settled()

      expect(response.statusCode).toBe(200)
      expect(counted).toEqual([])
    })

    /**
     * **Not an oracle.** The answer is byte-identical whether the key resolved,
     * did not, or was never sent, so nothing about the attribution can be read
     * back out of a response.
     */
    it('answers identically whatever credential was or was not presented', async () => {
      const { app, apiKey } = await citizen()
      const url = '/v1/tools/kolonie.quests.write'

      const [withKey, withBadKey, without] = await Promise.all([
        app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${apiKey}` } }),
        app.inject({ method: 'GET', url, headers: { authorization: 'Bearer not-a-key' } }),
        app.inject({ method: 'GET', url }),
      ])

      expect(withKey.body).toBe(without.body)
      expect(withBadKey.body).toBe(without.body)
      expect(withKey.statusCode).toBe(without.statusCode)
      expect(withBadKey.statusCode).toBe(without.statusCode)
    })

    /**
     * An app built without a rollup installs no hook at all, which is what every
     * test in this repository that predates the rollup is running against.
     */
    it('serves identically when no rollup was wired', async () => {
      const colony = fakeColony()
      const app = buildApp(colony)
      await app.ready()
      const registered = await colony.registry.register(
        { name: 'canary', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: { authorization: `Bearer ${registered.response.credentials.apiKey}` },
      })

      expect(response.statusCode).toBe(200)
    })
  })

  describe('the MCP door', () => {
    /**
     * The door that hijacks its socket, so the response hook never sees it. A
     * rollup blind to this one would be blind to the surface the observation
     * behind `#835` was actually made on.
     */
    it('counts a tool call under the tool’s own name', async () => {
      const colony = fakeColony()
      const { rollup, counted } = recordingRollup()
      const registered = await colony.registry.register(
        { name: 'canary', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
      const agentId = registered.response.agent.id

      const { client, close } = await connectedClient(
        { ...colony, rollup },
        `Bearer ${registered.response.credentials.apiKey}`,
        agentId,
      )
      await client.callTool({ name: 'kolonie.me', arguments: {} })
      await settled()
      await close()

      expect(counted).toHaveLength(1)
      expect(counted[0]?.agentId).toBe(agentId)
      expect(counted[0]?.call.routeKey).toBe('kolonie.me')
      expect(counted[0]?.call.status).toBe(200)
      expect(counted[0]?.call.bytesOut).toBeGreaterThan(0)
    })

    /**
     * A stranger has no citizenship to be counted against — the same rule the
     * HTTP door follows, arrived at from the other side: the unauthenticated
     * tier is built without an `agentId` at all.
     */
    it('counts nothing for the unauthenticated tier', async () => {
      const colony = fakeColony()
      const { rollup, counted } = recordingRollup()

      const { client, close } = await connectedClient({ ...colony, rollup })
      await client.callTool({ name: 'kolonie.about', arguments: {} })
      await settled()
      await close()

      expect(counted).toEqual([])
    })
  })
})
