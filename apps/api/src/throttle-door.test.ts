import { describe, expect, it } from 'vitest'
import {
  THROTTLE_CALLS_PER_HOUR,
  ThrottleSchema,
  throttleRefusal,
  type AgentId,
  type ApiError,
} from '@kolonie-ai/core'
import { buildApp } from './app.js'
import { FAKE_CALLER_IP, fakeColony } from './__fixtures__/colony/index.js'
import { connectedClient } from './__fixtures__/mcp.js'
import { gateFor, throttling, type ThrottleGate } from './throttle-gate.js'

const NOW = new Date('2026-08-14T12:00:00.000Z')

/** What the gate was asked, in the order it was asked. */
type Asked = { readonly agentId: AgentId; readonly routeKey: string }

const aRefusal = (routeKey: string): ApiError =>
  throttleRefusal(
    ThrottleSchema.parse({
      id: '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d',
      diagnosisId: '9f1c2e2a-3c1e-4f5a-9c1a-2b3c4d5e6f70',
      agentId: '4d3c2b1a-0f9e-4d8c-9b7a-6e5d4c3b2a10',
      routeKeys: [routeKey],
      callsPerHour: THROTTLE_CALLS_PER_HOUR,
      ordinal: 1,
      appliedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 4 * 60 * 60 * 1000).toISOString(),
      policyVersion: 'doctor-2026-08-01',
      kind: 'polling-loop',
      supportTicketId: null,
    }),
    NOW,
  )

/**
 * A gate that refuses the routes it names and answers nothing for the rest,
 * recording every question — because *which key was asked* is half of what these
 * tests are about.
 */
const recordingGate = (narrowed: readonly string[] = []) => {
  const asked: Asked[] = []
  const gate: ThrottleGate = {
    refusalFor: async (agentId, routeKey) => {
      asked.push({ agentId, routeKey })
      return narrowed.includes(routeKey) ? aRefusal(routeKey) : undefined
    },
  }
  return { gate, asked }
}

/**
 * The two doors a limit is enforced at (`#843`).
 *
 * The Doctor writes throttles and these read them, and the failure this file
 * exists for is the one that would look from the outside exactly like a limit
 * that had expired: **a citizen routing around a limit by using the other
 * surface**. `routes/mcp.ts` hijacks its socket, so `callerFor` — the seam all
 * 83 authenticated HTTP routes pass through — is never reached there. Both doors
 * are asserted here, against one gate object, because a limit installed on one
 * of them is not a limit.
 *
 * The other three are each a way of refusing somebody who is owed a call. **The
 * key asked is the route template**, so a limit written from evidence about
 * `/v1/tasks/:taskId` is not silently unenforceable. **A gate that throws
 * allows**, so an unwell database does not begin narrowing the whole Colony.
 * **A stranger is never asked about**, because a refusal needs a citizen.
 */
describe('the throttle at both doors', () => {
  const citizen = async (narrowed: readonly string[] = []) => {
    const colony = fakeColony()
    const { gate, asked } = recordingGate(narrowed)

    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return {
      colony,
      gate,
      asked,
      apiKey: registered.response.credentials.apiKey,
      agentId: registered.response.agent.id,
    }
  }

  describe('the HTTP door', () => {
    it('refuses a narrowed route with the status and the header', async () => {
      const { colony, gate, apiKey } = await citizen(['/v1/tasks'])
      const app = buildApp({ ...colony, throttles: gate })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers: { authorization: `Bearer ${apiKey}` },
      })

      expect(response.statusCode).toBe(429)
      /**
       * **The header as well as the field.** A client library acts on
       * `Retry-After` without being taught anything about this Colony, and the
       * same number is in the body for the agent reading it.
       */
      expect(response.headers['retry-after']).toBe(String(4 * 60 * 60))
      expect(response.json()).toMatchObject({ code: 'rate_limited' })
    })

    it('serves a route the limit does not name', async () => {
      const { colony, gate, apiKey } = await citizen(['/v1/tasks'])
      const app = buildApp({ ...colony, throttles: gate })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/v1/tasks/frontier',
        headers: { authorization: `Bearer ${apiKey}` },
      })

      expect(response.statusCode).toBe(200)
    })

    /**
     * **The route a narrowed citizen reads its own standing on.** `#843` names
     * it in `NEVER_THROTTLED_ROUTE_KEYS`, so the guard would refuse to plan a
     * limit over it — and it is unreachable from here for a second reason,
     * asserted so that a future refactor cannot make it depend on only one: this
     * route resolves its own caller rather than passing through `callerFor`.
     */
    it('serves the standing route even against a gate that refuses everything', async () => {
      const { colony, apiKey } = await citizen()
      const refusingEverything: ThrottleGate = {
        refusalFor: async (_agentId, routeKey) => aRefusal(routeKey),
      }
      const app = buildApp({ ...colony, throttles: refusingEverything })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: { authorization: `Bearer ${apiKey}` },
      })

      expect(response.statusCode).toBe(200)
    })

    /**
     * **The template, never the resolved path.** A finding names what the rollup
     * counted, the throttle names what the finding named, and this is where that
     * one string is matched — a limit checked against `/v1/tasks/8f2…` would
     * never fire for any citizen and nothing would say so.
     */
    it('asks about the route template rather than the path', async () => {
      const { colony, gate, asked, apiKey, agentId } = await citizen()
      const app = buildApp({ ...colony, throttles: gate })
      await app.ready()

      await app.inject({
        method: 'GET',
        url: '/v1/tasks/1f0d6f8e-5c2b-4a1e-9d3c-7b8a9c0d1e2f',
        headers: { authorization: `Bearer ${apiKey}` },
      })

      expect(asked).toEqual([{ agentId, routeKey: '/v1/tasks/:taskId' }])
    })

    /**
     * A read that went slow is not a reason to narrow somebody. The alternative
     * is a Colony that starts limiting every citizen the moment the database is
     * unwell, which is a worse failure than a limit that missed a few calls.
     */
    it('serves the call when the gate itself fails', async () => {
      const { colony, apiKey } = await citizen()
      const unwell: ThrottleGate = {
        refusalFor: async () => {
          throw new Error('the database is unwell')
        },
      }
      const app = buildApp({ ...colony, throttles: unwell })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers: { authorization: `Bearer ${apiKey}` },
      })

      expect(response.statusCode).toBe(200)
    })

    /** A refusal needs a citizen, and a stranger is answered before this. */
    it('asks nothing about a call that presented no credential', async () => {
      const { colony, gate, asked } = await citizen(['/v1/tasks'])
      const app = buildApp({ ...colony, throttles: gate })
      await app.ready()

      const response = await app.inject({ method: 'GET', url: '/v1/tasks' })

      expect(response.statusCode).toBe(401)
      expect(asked).toEqual([])
    })

    /**
     * An app built without a gate checks nothing and pays nothing, which is how
     * a surface is switched off here (D-013) — and it is what every API test
     * predating `#843` is running against.
     */
    it('serves identically when no gate was wired', async () => {
      const { colony, apiKey } = await citizen()
      const app = buildApp(colony)
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/v1/tasks',
        headers: { authorization: `Bearer ${apiKey}` },
      })

      expect(response.statusCode).toBe(200)
    })
  })

  describe('the MCP door', () => {
    /**
     * **A tool name is a route key**, so `kolonie.me` is one string through the
     * rollup, the finding and the limit, and there is no mapping for a future
     * surface to get wrong.
     */
    it('refuses a narrowed tool under the tool’s own name', async () => {
      const { colony, gate, asked, apiKey, agentId } = await citizen(['kolonie.me'])

      const { client, close } = await connectedClient(
        { ...colony, throttles: gate },
        `Bearer ${apiKey}`,
        agentId,
      )
      const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
      await close()

      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ error: { code: 'rate_limited' } })
      expect(asked).toEqual([{ agentId, routeKey: 'kolonie.me' }])
    })

    /**
     * **Asked before the handler**, which is the whole point of a limit: a
     * refusal produced after the work was done would cost the Colony exactly
     * what the throttle exists to stop it spending.
     */
    it('does not reach the tool it refused', async () => {
      const { colony, gate, apiKey, agentId } = await citizen(['kolonie.vault.list'])
      let reached = 0
      const vault = {
        ...colony.vault,
        vault: {
          ...colony.vault.vault,
          list: async () => {
            reached += 1
            return []
          },
        },
      }

      const { client, close } = await connectedClient(
        { ...colony, vault, throttles: gate },
        `Bearer ${apiKey}`,
        agentId,
      )
      await client.callTool({ name: 'kolonie.vault.list', arguments: {} })
      await close()

      expect(reached).toBe(0)
    })

    /** A stranger has no citizen to hold a limit, so nothing is asked. */
    it('asks nothing for the unauthenticated tier', async () => {
      const { colony, gate, asked } = await citizen(['kolonie.about'])

      const { client, close } = await connectedClient({ ...colony, throttles: gate })
      await client.callTool({ name: 'kolonie.about', arguments: {} })
      await close()

      expect(asked).toEqual([])
    })
  })

  /**
   * The seam itself. Both doors reach the gate off the store rather than through
   * an argument at 83 call sites, and this is the property that makes that safe:
   * a store nobody wrapped carries nothing, and two apps built in one process do
   * not share an entry.
   */
  describe('how the gate reaches them', () => {
    it('carries the gate on the wrapped store and not on the original', () => {
      const { gate } = recordingGate()
      const store = fakeColony().store
      const gated = throttling(store, gate)

      expect(gateFor(gated)).toBe(gate)
      expect(gateFor(store)).toBeUndefined()
    })

    it('keeps one app’s gate out of another built on the same store', () => {
      const first = recordingGate()
      const second = recordingGate()
      const store = fakeColony().store

      expect(gateFor(throttling(store, first.gate))).toBe(first.gate)
      expect(gateFor(throttling(store, second.gate))).toBe(second.gate)
    })
  })
})
