import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { webServerPermissionRequest, type AgentId } from '@kolonie-ai/core'
import { fakeWebServer, fakeWebServerChallenges } from './__fixtures__/web-server.js'
import { openWebServerChallenge } from './web-server.js'

/**
 * The operator question in front of the `web-server` rung (#244).
 *
 * The three things a reviewer cannot see by reading the diff: that a citizen
 * declaring somebody else's machine really is stopped before it mints anything,
 * that the request text is the Colony's and names what it costs, and that
 * **nothing about the Colony's permission model moves when the operator agrees**.
 */
describe('the web-server rung’s operator question', () => {
  const anAgent = () => randomUUID() as AgentId

  const mint = (agentId: AgentId, body: unknown, deps: ReturnType<typeof fakeWebServer>) =>
    openWebServerChallenge(agentId, 'server-runner', body, deps)

  describe('a citizen whose machine is its own', () => {
    it('is not asked anything and gets its first probe', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()

      const result = await mint(
        agentId,
        { origin: 'https://example.org', machineIsSolelyMine: true },
        deps,
      )

      expect(result.outcome).toBe('open')
      if (result.outcome === 'open') {
        expect(result.challenge.probe?.which).toBe('first')
      }
      expect(deps.challenges.asks()).toBe(0)
      expect(deps.challenges.shelved(agentId)).toBe(false)
    })
  })

  describe('a citizen declaring somebody else’s machine', () => {
    it('is stopped before anything is minted, and the task is shelved', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()

      const result = await mint(
        agentId,
        { origin: 'https://example.org', machineIsSolelyMine: false },
        deps,
      )

      expect(result.outcome).toBe('awaiting-operator')
      expect(deps.challenges.shelved(agentId)).toBe(true)

      /**
       * Nothing minted, and the ordering is the point: a citizen handed a path
       * and a code would have run the server the question is about before the
       * question was answered.
       */
      expect(await deps.challenges.open(agentId)).toBeUndefined()
    })

    it('is not asked twice while it is already waiting', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      const body = { origin: 'https://example.org', machineIsSolelyMine: false }

      await mint(agentId, body, deps)
      const second = await mint(agentId, body, deps)

      expect(second.outcome).toBe('awaiting-operator')
      if (second.outcome === 'awaiting-operator') {
        expect(second.message).toContain('already been asked')
      }
      expect(deps.challenges.asks()).toBe(1)
    })

    it('proceeds once an operator has come back', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      const body = { origin: 'https://example.org', machineIsSolelyMine: false }

      await mint(agentId, body, deps)
      deps.challenges.operatorAnswers(agentId)

      const result = await mint(agentId, body, deps)

      expect(result.outcome).toBe('open')
      if (result.outcome === 'open') expect(result.challenge.probe?.which).toBe('first')
    })
  })

  describe('the request text', () => {
    const text = webServerPermissionRequest('https://example.org:8443')

    it('names the address, the public reachability, and that it is withdrawable', () => {
      expect(text).toContain('https://example.org:8443')
      expect(text).toContain('publicly reachable')
      expect(text).toContain('withdraw this at any time')
    })

    it('says what it costs the operator rather than only what is wanted', () => {
      expect(text).toContain('open port')
      expect(text).toContain('abuse contact')
    })

    it('tells the operator that declining does not block the citizen', () => {
      expect(text).toContain('not blocked')
    })

    /**
     * `#236` refuses any message matching a credential shape, in both
     * directions. A Colony-authored request that quoted an example token would be
     * refused by the very channel carrying it — so the text must never contain
     * anything shaped like one.
     */
    it('carries nothing that looks like a credential', async () => {
      const { looksLikeCredential } = await import('@kolonie-ai/core')
      expect(looksLikeCredential(text)).toBe(false)
    })
  })

  describe('the origin', () => {
    const cases: [string, string][] = [
      ['not a url at all', 'nonsense'],
      ['a scheme the Colony will not fetch', 'ftp://example.org'],
      ['a path, which the Colony supplies', 'https://example.org/serve/here'],
      ['a query, which is more likely a mistake than an intent', 'https://example.org/?a=1'],
    ]

    for (const [why, origin] of cases) {
      it(`refuses ${why}`, async () => {
        const deps = fakeWebServer()
        const result = await mint(anAgent(), { origin, machineIsSolelyMine: true }, deps)

        expect(result.outcome).toBe('rejected')
      })
    }

    it('keeps a non-default port, because that is where the server is', async () => {
      const deps = fakeWebServer()
      const result = await mint(
        anAgent(),
        { origin: 'http://example.org:8080/', machineIsSolelyMine: true },
        deps,
      )

      expect(result.outcome).toBe('open')
      if (result.outcome === 'open') expect(result.challenge.origin).toBe('http://example.org:8080')
    })
  })

  describe('what does not change', () => {
    /**
     * The acceptance criterion the rung turns on. There is no permission to
     * assert *about* here — which is the finding, and it is asserted as the
     * absence it is: no surface in this module takes or returns an autonomy
     * level, a permission flag, or anything a caller could set.
     */
    it('has no path that could carry a permission at all', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      deps.challenges.operatorAnswers(agentId)

      const result = await mint(
        agentId,
        {
          origin: 'https://example.org',
          machineIsSolelyMine: false,
          // Everything a caller might hope moves something. All ignored: the
          // schema does not know these names and does not pass them on.
          level: 'free',
          challengesAllowed: true,
          autonomy: 'free',
          grant: true,
        },
        deps,
      )

      expect(result.outcome).toBe('open')
      if (result.outcome === 'open') {
        const shown = JSON.stringify(result.challenge)
        expect(shown).not.toContain('free')
        expect(shown).not.toContain('challengesAllowed')
      }
    })

    it('refuses to mint when the machine is shared and the Colony cannot reach anybody', async () => {
      const challenges = fakeWebServerChallenges()
      const deps = fakeWebServer({ challenges })
      const agentId = anAgent()

      const result = await mint(
        agentId,
        { origin: 'https://example.org', machineIsSolelyMine: false },
        deps,
      )

      expect(result.outcome).toBe('awaiting-operator')
      expect(await challenges.open(agentId)).toBeUndefined()
    })
  })
})
