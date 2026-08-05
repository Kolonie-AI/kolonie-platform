import { describe, expect, it } from 'vitest'
import { ACADEMY_TASKS } from '@kolonie-ai/db'
import { AUTHENTICATED_TOOLS, UNAUTHENTICATED_TOOLS, STEWARD_TOOLS } from '../../tool-list.js'
import { connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'
import { ARGUMENT_LESS_MINTS, outOfReach } from './mints.js'

/**
 * The fold (`#385`): fourteen argument-less minting tools served as `kind`
 * values of the dispatcher that already served six browser stages.
 *
 * What is asserted here is the part no per-rung test can see — that the set is
 * complete, that nothing points at a tool which no longer exists, and that the
 * refusals say enough to act on. Each rung's own mint is asserted in the test
 * file it always had, which now calls the dispatcher.
 */
describe('the folded argument-less mints', () => {
  /**
   * **The property that keeps a rung clearable.** A rung whose seeded
   * instructions name a tool that is not registered is a rung no citizen can
   * clear, and the seeded text is the only place most citizens will look.
   *
   * Asserted over **all** seeded rungs rather than the ones this issue touched,
   * so a rung added later cannot quietly reintroduce a dead name.
   */
  it('names no unregistered tool in any seeded rung’s instructions', () => {
    const registered = new Set<string>([
      ...UNAUTHENTICATED_TOOLS,
      ...AUTHENTICATED_TOOLS,
      ...STEWARD_TOOLS,
    ])

    /**
     * The Colony's own domains read like tool names and are not. They are listed
     * rather than pattern-matched away, because a pattern loose enough to
     * exclude them is loose enough to excuse a real dead tool.
     */
    const domains = new Set(['kolonie.sh', 'kolonie.ai', 'kolonie.email', 'kolonie.to'])

    const dead = ACADEMY_TASKS.flatMap((task) => {
      const named = task.instructions.match(/kolonie\.[a-z0-9.-]*[a-z0-9]/g) ?? []
      return named
        .filter((name) => !registered.has(name) && !domains.has(name))
        .map((name) => `${task.type}: ${name}`)
    })

    expect(dead).toEqual([])
  })

  /** Every kind the registry offers is one the dispatcher will actually take. */
  it('offers every folded kind through the one dispatcher', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).toContain('kolonie.academy.challenge')
    for (const mint of ARGUMENT_LESS_MINTS) {
      expect(names).not.toContain(`kolonie.academy.${mint.kind}.challenge`)
    }
    await close()
  })

  /**
   * The description is the only place this set is discoverable now, so it
   * carries the whole set rather than examples — the same rule `#213` established
   * for the browser stages one family over.
   */
  it('lists every folded kind in the description a citizen reads', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === 'kolonie.academy.challenge',
    )

    for (const mint of ARGUMENT_LESS_MINTS) {
      expect(tool?.description).toContain(`"${mint.kind}"`)
    }
    await close()
  })

  /**
   * **The argument-taking half stayed**, which is the other half of the
   * decision: those take a signature, an address, a nonce or an answer, and
   * folding them would push a real type distinction into an untyped payload.
   */
  /**
   * `#385` kept these eight registered because they take real arguments;
   * `#415` measured that a discriminated union costs more schema than the
   * eleven descriptions it would replace, folded them behind
   * `kolonie.academy.answer` with a flat shape, and enforced the contract in the
   * handler. So the assertion inverts: none of them is a tool any more, and each
   * is a `kind`.
   */
  it('serves the tools with real argument shapes as kinds of one answer tool', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const names = (await client.listTools()).tools.map((tool) => tool.name)
    const answer = (await client.listTools()).tools.find(
      (tool) => tool.name === 'kolonie.academy.answer',
    )

    for (const kind of [
      'pow.solve',
      'key.sign',
      'solana.address',
      'vision.solve',
      'email.code',
      'email.challenge',
      'web-server.challenge',
      'authenticator.check',
    ]) {
      expect(names).not.toContain(`kolonie.academy.${kind}`)
      // And the kind that replaced it is named where a chooser reads it.
      expect(answer?.description, kind).toContain(`"${kind}"`)
    }
    await close()
  })

  /**
   * **A rejection case.** An unknown kind is refused with both vocabularies —
   * before the fold the message listed only the six browser stages, which after
   * it would be a true sentence hiding most of the answer.
   */
  it('refuses an unknown kind, naming both families', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'not-a-rung' },
    })

    expect(result.isError).toBe(true)
    const text = JSON.stringify(result.content)
    expect(text).toContain('not-a-rung')
    expect(text).toContain('capability')
    expect(text).toContain('proof-of-work')
    await close()
  })

  /**
   * **The second rejection case.** A kind naming a rung the caller cannot reach
   * is refused with the rung and what it needs, rather than minting a challenge
   * whose submission would be turned away for the same reason.
   *
   * Asserted against `outOfReach` directly rather than through a call, because
   * what reaches it is the catalogue's answer and the MCP fixture has no seeded
   * catalogue to give one. The seed is the real input either way, so this feeds
   * it the real rung.
   *
   * `email-send` is the one folded rung needing a skill other than `profile` —
   * it requires `mailbox` — which is what makes it the case worth asserting.
   */
  it('refuses a kind whose rung the caller cannot reach, naming the rung and what it needs', () => {
    const mint = ARGUMENT_LESS_MINTS.find((entry) => entry.kind === 'email-send')
    if (mint === undefined) throw new Error('email-send is no longer a folded kind')

    const rung = ACADEMY_TASKS.find((task) => task.type === mint.taskType)
    const refusal = outOfReach(mint, rung as never, ['profile'])

    expect(refusal).toContain('mailbox')
    expect(refusal).toContain('kolonie.tasks.frontier')
    // And it says what it is *not*: nothing is being withheld, because the
    // submission is gated for the same reason and would be either way.
    expect(refusal).toContain('Nothing is being withheld')
  })

  it('does not refuse a rung the caller can reach', () => {
    const mint = ARGUMENT_LESS_MINTS.find((entry) => entry.kind === 'vetting')
    if (mint === undefined) throw new Error('vetting is no longer a folded kind')

    const rung = ACADEMY_TASKS.find((task) => task.type === mint.taskType)

    expect(outOfReach(mint, rung as never, ['profile'])).toBeUndefined()
  })

  /**
   * A catalogue read that failed must not cost the citizen a mint: the
   * submission is gated either way, so it loses nothing it would otherwise have
   * had.
   */
  it('does not refuse when the catalogue could not say', () => {
    const mint = ARGUMENT_LESS_MINTS[0]
    if (mint === undefined) throw new Error('the registry is empty')

    expect(outOfReach(mint, undefined, [])).toBeUndefined()
  })
})
