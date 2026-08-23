import { describe, expect, it } from 'vitest'
import { ACADEMY_TASKS } from '@kolonie-ai/db'
import { registeredTools, toolNamesIn } from '../../tool-names.js'
import { connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'
import { ARGUMENT_LESS_MINTS, argumentLessMint, outOfReach } from './mints.js'
import { isWithdrawnRung } from '../../../withdrawn-rungs.js'

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
    /**
     * **The parser, not a second copy of it** (`#1322`).
     *
     * This read the names with a regex of its own, and `tool-list.test.ts` read
     * them with `toolNamesIn`. Two patterns for one grammar is two chances to be
     * wrong, and they were: neither admitted an underscore, so
     * `kolonie.messages.get_thread` was read as `kolonie.messages.get` in both —
     * a dead name reported about a tool that exists. `tool-names.ts` is where
     * that grammar lives and where its own history is written down, and it
     * already excludes the sister-project domains this used to list by hand.
     */
    const registered = registeredTools()

    const dead = ACADEMY_TASKS.flatMap((task) =>
      toolNamesIn(task.instructions)
        .filter((name) => !registered.has(name))
        .map((name) => `${task.type}: ${name}`),
    )

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
   * **Where this set is discoverable moved, and the property did not** (`#1652`).
   *
   * It was `kolonie.academy.challenge`'s own description, which carried the whole
   * set rather than examples — `#213`'s rule, and right. What it also meant is
   * that every citizen paid for every kind in every session whether or not it
   * went near one. `kolonie.academy.list` serves the same registry on request,
   * so the set is still complete and is no longer in the prefix.
   *
   * **Except a rung that has been withdrawn** (`#954`). A retired rung stays in
   * the registry so the dispatcher can refuse it *by name and with its reason*
   * rather than answering *no such kind*, but a citizen choosing from this list
   * must not be sent at one. The rejection case below is the half that matters:
   * absent from the list, still dispatchable.
   */
  it('lists every folded kind, from the set rather than from a literal', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const listed = await client.callTool({
      name: 'kolonie.academy.list',
      arguments: { family: 'mint' },
    })
    const kinds = (
      listed.structuredContent as { families: { mint: { rungs: { kind: string }[] } } }
    ).families.mint.rungs.map((rung) => rung.kind)

    for (const mint of ARGUMENT_LESS_MINTS.filter((mint) => !isWithdrawnRung(mint.taskType))) {
      expect(kinds, mint.kind).toContain(mint.kind)
    }
    await close()
  })

  /**
   * **The invariant `#1652` buys, stated as the property rather than as a byte
   * count.**
   *
   * Adding a rung must cost the published catalogue nothing. A committed number
   * would have to be edited by whoever adds one, which makes it a chore — and
   * the one edit that matters is the one that would look like all the others.
   * What is asserted instead is the reason the number cannot move: **the
   * published description mentions no rung except through a `guarantee`**, so a
   * rung without one contributes no bytes by construction.
   *
   * A rung carrying a `guarantee` is the deliberate exception and does move it.
   * That is `#384`'s protected class — a sentence read *before* the decision to
   * call — and `mints.ts` says at length why these are published and why a
   * further one is an argument rather than an addition.
   */
  it('mentions no rung in the published description except through a guarantee', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const published =
      (await client.listTools()).tools.find(
        (candidate) => candidate.name === 'kolonie.academy.challenge',
      )?.description ?? ''

    expect(published).not.toBe('')

    const silent = ARGUMENT_LESS_MINTS.filter((mint) => mint.guarantee === undefined)
    const speaking = ARGUMENT_LESS_MINTS.filter((mint) => mint.guarantee !== undefined)

    // The set is mostly silent, or this assertion is measuring nothing.
    expect(silent.length).toBeGreaterThan(speaking.length)

    for (const mint of silent) {
      expect(published, mint.kind).not.toContain(mint.kind)
    }
    for (const mint of speaking) {
      expect(published, mint.kind).toContain(mint.guarantee ?? '')
    }
    await close()
  })

  /** Rejection case: a withdrawn kind is not offered, and is still recognised. */
  it('offers no withdrawn kind, while the dispatcher still knows it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const listed = await client.callTool({
      name: 'kolonie.academy.list',
      arguments: { family: 'mint' },
    })
    const kinds = (
      listed.structuredContent as { families: { mint: { rungs: { kind: string }[] } } }
    ).families.mint.rungs.map((rung) => rung.kind)

    const withdrawn = ARGUMENT_LESS_MINTS.filter((mint) => isWithdrawnRung(mint.taskType))
    expect(withdrawn.length).toBeGreaterThan(0)
    for (const mint of withdrawn) {
      expect(kinds).not.toContain(mint.kind)
      expect(argumentLessMint(mint.kind)?.taskType).toBe(mint.taskType)
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

    /**
     * Where a chooser reads the kind moved to `kolonie.academy.list` (`#1652`);
     * that each old tool is gone and each kind exists did not.
     */
    const listed = await client.callTool({
      name: 'kolonie.academy.list',
      arguments: { family: 'answer' },
    })
    const kinds = (
      listed.structuredContent as { families: { answer: { rungs: { kind: string }[] } } }
    ).families.answer.rungs.map((rung) => rung.kind)

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
      expect(kinds, kind).toContain(kind)
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
