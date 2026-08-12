import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { webServerPermissionRequest, type AgentId } from '@kolonie-ai/core'
import { fakeOperatorRequests } from './__fixtures__/operator-requests.js'
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

    it('names the direct controls rendered for the operator', async () => {
      const operatorRequests = fakeOperatorRequests()
      const taskId = operatorRequests.store.giveTask('web-server-verify')
      const challenges = fakeWebServerChallenges(taskId)
      const agentId = anAgent()
      operatorRequests.store.givePage(agentId)
      const deps = fakeWebServer({ challenges, operatorRequests })

      const result = await mint(
        agentId,
        { origin: 'https://example.org', machineIsSolelyMine: false },
        deps,
      )

      expect(result.outcome).toBe('awaiting-operator')
      if (result.outcome !== 'awaiting-operator') throw new Error('expected to be waiting')
      expect(result.asked).toBe(true)
      expect(result.message).toContain('Allow and Refuse')
      expect(result.message).toContain('explain instead')
      expect(result.message).not.toContain('There is no button')
    })

    it('is not asked twice while it is already waiting', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      const body = { origin: 'https://example.org', machineIsSolelyMine: false }

      await mint(agentId, body, deps)
      // A request about this rung really exists now. `operatorAsked` is that row
      // and not the shelving beside it (`#567`).
      deps.challenges.operatorAsks(agentId)
      const second = await mint(agentId, body, deps)

      expect(second.outcome).toBe('awaiting-operator')
      if (second.outcome === 'awaiting-operator') {
        expect(second.message).toContain('already been asked')
      }
      expect(deps.challenges.asks()).toBe(1)
    })

    /**
     * `#567`. A citizen was told *your operator has been asked* when no request
     * had been opened, and was handed `kolonie.operator.request.read` for a row
     * that did not exist. It then sent its operator, five times over four days,
     * to look for a control that was never going to be on the page — because
     * `ask` counted every rejection as a successful ask.
     *
     * Measured in production on 2026-08-08 while this was being fixed: **zero**
     * operator requests have ever existed for `web-server-verify`.
     */
    describe('when the question could not be put', () => {
      it('does not say the operator was asked', async () => {
        const deps = fakeWebServer()
        const agentId = anAgent()

        const result = await mint(
          agentId,
          { origin: 'https://example.org', machineIsSolelyMine: false },
          deps,
        )

        expect(result.outcome).toBe('awaiting-operator')
        if (result.outcome === 'awaiting-operator') {
          expect(result.asked).toBe(false)
          expect(result.message).toContain('has not been asked')
          // The three things it was claiming: that somebody was asked, that
          // there is something on the page, and that there is an answer to read.
          expect(result.message).not.toContain('has been asked')
          expect(result.message).toContain('nothing for them to answer')
          expect(result.message).not.toContain('kolonie.operator.request.read')
        }
      })

      it('goes on saying so, rather than claiming it succeeded the second time', async () => {
        const deps = fakeWebServer()
        const agentId = anAgent()
        const body = { origin: 'https://example.org', machineIsSolelyMine: false }

        await mint(agentId, body, deps)
        const second = await mint(agentId, body, deps)

        if (second.outcome !== 'awaiting-operator') throw new Error('expected to be waiting')
        expect(second.message).toContain('has not been asked')
      })

      it('names what the citizen can do instead, so the rung is not simply lost', async () => {
        const deps = fakeWebServer()
        const agentId = anAgent()

        const result = await mint(
          agentId,
          { origin: 'https://example.org', machineIsSolelyMine: false },
          deps,
        )

        if (result.outcome !== 'awaiting-operator') throw new Error('expected to be waiting')
        // The reporter's own ask: say there is no way, and let it set the rung
        // aside in one call instead of waiting on nobody.
        expect(result.message).toContain('kolonie.tasks.set-aside')
        expect(result.message).toContain('you keep website')
      })
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

  /**
   * The contract, which this rung did not read until `#660`.
   *
   * `#659` gave the contract a `web-server` field and nothing consulted it, so
   * the form told an operator it had decided something the Colony then asked
   * them about anyway — and an answer that lived only in the exchange could not
   * be taken back, which left `#658`'s withdrawal path with a hole in it.
   */
  describe('the contract capability', () => {
    const elsewhere = { origin: 'https://example.org', machineIsSolelyMine: false }

    it('proceeds without asking anybody where the contract grants it', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      deps.challenges.contractRecorded(agentId, {
        capabilities: ['web-server'],
        defaultRule: 'ask',
      })

      const result = await mint(agentId, elsewhere, deps)

      expect(result.outcome).toBe('open')
      if (result.outcome === 'open') expect(result.permittedBy).toBe('contract')
      // The half an operator ticking the box was promised: no second question.
      expect(deps.challenges.asks()).toBe(0)
      expect(deps.challenges.shelved(agentId)).toBe(false)
    })

    it('stops the next attempt once the capability is withdrawn', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      deps.challenges.contractRecorded(agentId, {
        capabilities: ['web-server'],
        defaultRule: 'ask',
      })
      expect((await mint(agentId, elsewhere, deps)).outcome).toBe('open')

      // `#658`: a new version supersedes rather than edits, and this rung reads
      // the current one on every attempt rather than remembering the last.
      deps.challenges.contractRecorded(agentId, { capabilities: [], defaultRule: 'refrain' })

      expect((await mint(agentId, elsewhere, deps)).outcome).toBe('refused-by-contract')
    })

    it('refuses without asking where the rule is to refrain', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      deps.challenges.contractRecorded(agentId, { capabilities: [], defaultRule: 'refrain' })

      const result = await mint(agentId, elsewhere, deps)

      expect(result.outcome).toBe('refused-by-contract')
      if (result.outcome === 'refused-by-contract') {
        // It names the capability and where it is granted, so the citizen can
        // say what its operator would have to do.
        expect(result.message).toContain('web-server')
        expect(result.message).toContain('kolonie.autonomy.read')
        expect(result.message).toContain('kolonie.tasks.set-aside')
      }
      // Nothing was asked and nothing was set aside on a question nobody sent.
      expect(deps.challenges.asks()).toBe(0)
      expect(deps.challenges.shelved(agentId)).toBe(false)
    })

    it('still asks where the contract is silent and its rule is to ask', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      deps.challenges.contractRecorded(agentId, { capabilities: [], defaultRule: 'ask' })

      expect((await mint(agentId, elsewhere, deps)).outcome).toBe('awaiting-operator')
      expect(deps.challenges.shelved(agentId)).toBe(true)
    })

    it('asks where there is no contract at all, rather than refusing', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()

      expect((await mint(agentId, elsewhere, deps)).outcome).toBe('awaiting-operator')
    })

    it('writes an answered request into the contract, so it can be withdrawn', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      deps.challenges.contractRecorded(agentId, { capabilities: [], defaultRule: 'ask' })

      await mint(agentId, elsewhere, deps)
      deps.challenges.operatorAnswers(agentId)
      const result = await mint(agentId, elsewhere, deps)

      expect(result.outcome).toBe('open')
      if (result.outcome === 'open') expect(result.permittedBy).toBe('operator-answer')
      expect(deps.challenges.capabilitiesOf(agentId)).toContain('web-server')
    })

    /**
     * An answer with no contract behind it still lets the citizen through.
     *
     * The grant is what `#660` adds; it is not a new gate. A citizen whose
     * operator answered before ever recording a contract would otherwise be
     * refused by a rung that used to let it past, on the strength of a
     * permission it was actually given.
     */
    it('proceeds on an answer even where there is nothing to write it into', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()

      await mint(agentId, elsewhere, deps)
      deps.challenges.operatorAnswers(agentId)

      expect((await mint(agentId, elsewhere, deps)).outcome).toBe('open')
      expect(deps.challenges.capabilitiesOf(agentId)).toBeUndefined()
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
      expect(text).toContain('attack surface')
      expect(text).toContain('abuse contact')
    })

    /**
     * `#497`. The text named one cost — *an open port on your machine* — and it
     * is the wrong one for most citizens: `INBOUND_ROUTES` calls a tunnel *the
     * ordinary case*, and a tunnel opens no inbound port at all. An operator
     * read it exactly as written and answered that they could not forward a
     * port, one step from declining a rung over a requirement that does not
     * exist.
     *
     * **Both shapes are asserted separately so a later edit cannot quietly
     * collapse them into one**, which is what this issue asked for and is the
     * state the text was already in.
     */
    it('names the tunnel case, in which no port is opened', () => {
      expect(text).toContain('tunnel')
      expect(text).toContain('no port on your router is opened')
      expect(text).toContain('the ordinary case')
    })

    it('keeps the direct-port cost for the case where it applies', () => {
      expect(text).toContain('forwarded port')
      expect(text).toContain('attack surface that was not there before')
    })

    it('does not present either case as the one that applies here', () => {
      // `origin` cannot tell them apart — a tunnel's public URL and a forwarded
      // port's address look the same from the outside, which is the point of a
      // tunnel. So the operator is handed the question rather than an answer,
      // and it is addressed to the party that actually knows.
      expect(text).toContain('Ask me which of the two it is')
      expect(text).toContain('the address alone does not say')
    })

    /**
     * The field exists and using it here would be wrong twice over: `attempt.ts`
     * says nothing reads `inboundRoute` as a gate, and its most common value is
     * `unknown`, which that schema defines as the same claim as saying nothing.
     * Telling an operator *no port will be opened* on the strength of an
     * undeclared field is the Colony manufacturing a fact the citizen did not
     * state.
     */
    it('takes no argument but the origin, so no declaration can be read as a verdict', () => {
      expect(webServerPermissionRequest).toHaveLength(1)
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

  /**
   * `#717`. Reporter 6's task was bound to a `trycloudflare` tunnel that had
   * died. Submitting to force failure correctly answered 502 and correctly left
   * the challenge alone — a failed attempt is not a reason to throw away a live
   * challenge — and every attempt to move to a working tunnel handed back the
   * dead one's second probe. There was no way out at all.
   */
  describe('a challenge bound to an origin that has stopped answering', () => {
    const own = (origin: string, replace?: boolean) => ({
      origin,
      machineIsSolelyMine: true,
      ...(replace === undefined ? {} : { replace }),
    })

    /**
     * **Said, rather than handed back silently.** Answering with the open
     * challenge's probe under a different origin is indistinguishable from the
     * Colony ignoring the argument, which is what the report describes.
     */
    it('refuses a different origin and names the way out', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      await mint(agentId, own('https://a-dead-tunnel.example'), deps)

      const result = await mint(agentId, own('https://a-live-tunnel.example'), deps)

      expect(result.outcome).toBe('rejected')
      if (result.outcome !== 'rejected') throw new Error('expected a refusal')
      expect(result.error.message).toContain('https://a-dead-tunnel.example')
      expect(result.error.message).toContain('"replace": true')
      // The price is named, because it is the reason this is not the default.
      expect(result.error.message).toContain('separation')
    })

    it('starts a fresh challenge at the new origin when replacement is explicit', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      await mint(agentId, own('https://a-dead-tunnel.example'), deps)

      const result = await mint(agentId, own('https://a-live-tunnel.example', true), deps)

      expect(result.outcome).toBe('open')
      if (result.outcome !== 'open') throw new Error('expected a fresh challenge')
      expect(result.challenge.origin).toBe('https://a-live-tunnel.example')
      expect(result.challenge.probe?.which).toBe('first')
    })

    /**
     * The rejection case this must not break: a repeat at the same origin is how
     * a citizen asks *what is next*, which is what the tool's own summary tells
     * it to do.
     */
    it('still answers an ordinary repeat at the same origin', async () => {
      const deps = fakeWebServer()
      const agentId = anAgent()
      const first = await mint(agentId, own('https://example.org'), deps)
      if (first.outcome !== 'open') throw new Error('expected a challenge')

      const again = await mint(agentId, own('https://example.org'), deps)

      expect(again.outcome).toBe('open')
      if (again.outcome !== 'open') throw new Error('expected the open challenge')
      expect(again.challenge.challengeId).toBe(first.challenge.challengeId)
    })
  })
})
