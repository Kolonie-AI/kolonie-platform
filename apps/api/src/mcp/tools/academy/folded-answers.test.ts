import { describe, expect, it } from 'vitest'
import { PERCEPTION_STAGE, perceptionCodeFor } from '@kolonie-ai/core'
import { FAKE_CALLER_IP, fakeColony } from '../../../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'
import { fakeVision, fakeVisionChallenges } from '../../../__fixtures__/vision.js'
import { ACADEMY_ANSWERS, answerArguments } from './answers.js'

/**
 * The fold (`#415`): eleven tools that take arguments served as `kind` values of
 * one dispatcher, the way `#385` folded fourteen argument-less mints.
 *
 * **What is asserted here is the part no per-rung test can see** — that the set
 * is complete, that both refusals say enough to act on, and that the kinds with
 * no test file of their own are reachable end to end. Each rung that already had
 * a test keeps it, now calling the dispatcher: `keys.test.ts`,
 * `proof-of-work.test.ts`, `solana.test.ts`, `memory.test.ts` and
 * `email.test.ts`.
 */
describe('the folded answer tools', () => {
  const kinds = ACADEMY_ANSWERS.map((entry) => entry.kind)

  it('serves every kind from one tool, and none of them as a tool', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).toContain('kolonie.academy.answer')
    for (const kind of kinds) {
      expect(names).not.toContain(`kolonie.academy.${kind}`)
    }
    // The whole `kolonie.academy.*` surface is three entries, which is the goal
    // `#415` states: mint, answer, retest.
    expect(names.filter((name) => name.startsWith('kolonie.academy.'))).toEqual([
      'kolonie.academy.challenge',
      'kolonie.academy.answer',
      'kolonie.academy.retest',
    ])
    await close()
  })

  /**
   * The vocabulary is derived rather than written out, which is the rule `#213`
   * and `#385` both established: a twelfth kind must appear on this surface
   * without anybody editing a sentence.
   */
  it('names every kind in the description, from the set rather than from a literal', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const answer = (await client.listTools()).tools.find(
      (tool) => tool.name === 'kolonie.academy.answer',
    )

    for (const kind of kinds) {
      expect(answer?.description, kind).toContain(`"${kind}"`)
    }
    // And every argument any kind takes is in the schema, described once.
    for (const field of answerArguments()) {
      expect(Object.keys(answer?.inputSchema.properties ?? {})).toContain(field)
    }
    await close()
  })

  /**
   * **A rejection case, and the one the flat argument shape exists to need.**
   * One optional field per argument cannot stop `nonce` reaching `key.sign`, so
   * the handler does — and the refusal names the kind and what that kind takes,
   * because a caller that sent the wrong field usually meant a different kind.
   */
  it('refuses an argument that belongs to another kind, naming what this one takes', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const refused = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'pow.solve', nonce: 'abc', publicKey: 'not mine to send here' },
    })

    expect(refused.isError).toBe(true)
    // The refusal travels as the Colony's ordinary error object, so the sentence
    // is inside it rather than being the text.
    const said = JSON.stringify(refused.content)
    const { message } = JSON.parse((refused.content as { text: string }[])[0]?.text ?? '{}') as {
      message: string
    }
    expect(message).toContain('publicKey')
    expect(message).toContain('"pow.solve"')
    expect(message).toContain('which takes nonce')
    // Nothing was submitted, which the refusal says because it is the fact a
    // caller needs before it retries.
    expect(said).toContain('Nothing was submitted')
    await close()
  })

  it('refuses a kind nobody serves, with the whole vocabulary', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const refused = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'key.signature' },
    })

    expect(refused.isError).toBe(true)
    const said = JSON.stringify(refused.content)
    expect(said).toContain('key.signature')
    for (const kind of kinds) {
      expect(said, kind).toContain(kind)
    }
    // And where the other half of a rung lives, since a caller that guessed one
    // name is a caller that may have wanted the mint.
    expect(said).toContain('kolonie.academy.challenge')
    await close()
  })

  it('refuses a call with no kind at all rather than guessing one', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const refused = await client.callTool({ name: 'kolonie.academy.answer', arguments: {} })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('No kind was given')
    await close()
  })

  /**
   * The one rung folded here that had no MCP test of its own, end to end through
   * a real client over a real transport: mint on one tool, answer on the other.
   */
  it('carries a citizen through the vision rung, mint to answer', async () => {
    const challenges = fakeVisionChallenges()
    const colony = { ...fakeColony(), vision: fakeVision(challenges) }
    const registered = await colony.registry.register(
      { name: 'sighted', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const { agent, credentials } = registered.response
    const { client, close } = await connectedClient(colony, `Bearer ${credentials.apiKey}`)

    const minted = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'vision' },
    })
    expect(minted.isError).toBeFalsy()

    const expected = challenges.expectedAnswerFor(agent.id)

    const solved = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'vision.solve', answer: expected ?? '' },
    })

    expect(solved.isError).toBeFalsy()
    expect((solved.structuredContent as { solved: boolean }).solved).toBe(true)
    await close()
  })

  it('clears a perception challenge with the code read from its rendered page', async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'page-reader', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const { agent, credentials } = registered.response
    const { client, close } = await connectedClient(colony, `Bearer ${credentials.apiKey}`)

    const minted = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'perception' },
    })
    const { challengeId } = minted.structuredContent as { challengeId: string }
    await colony.academy.challenges.observe(challengeId, PERCEPTION_STAGE, {
      rendered: true,
      cssWidth: 320,
      cssHeight: 96,
      devicePixelRatio: 1,
    })

    const solved = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: {
        kind: 'perception.reading',
        challengeId,
        value: perceptionCodeFor(challengeId),
      },
    })

    expect(solved.isError).toBeFalsy()
    expect(solved.structuredContent).toMatchObject({ status: 'verified' })
    expect(await colony.academy.challenges.clearedAt(agent.id, PERCEPTION_STAGE)).toBeTruthy()
    await close()
  })

  it('refuses a wrong perception reading without clearing the challenge', async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'page-misreader', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const { agent, credentials } = registered.response
    const { client, close } = await connectedClient(colony, `Bearer ${credentials.apiKey}`)

    const minted = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'perception' },
    })
    const { challengeId } = minted.structuredContent as { challengeId: string }
    await colony.academy.challenges.observe(challengeId, PERCEPTION_STAGE, {
      rendered: true,
      cssWidth: 320,
      cssHeight: 96,
      devicePixelRatio: 1,
    })

    const refused = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'perception.reading', challengeId, value: 'XXXXX' },
    })

    expect(refused.isError).toBe(true)
    expect(await colony.academy.challenges.clearedAt(agent.id, PERCEPTION_STAGE)).toBeNull()
    await close()
  })

  /**
   * **What a runtime does with the eleven arguments this kind does not take**
   * (`#508`).
   *
   * A flat schema offers every argument to every kind. A runtime that fills the
   * call has no `undefined` to write — JSON has none — so it writes `null`, and
   * `optional()` refused that before the handler ran: *"expected string, received
   * null"*, on every field at once. The citizen that reported it read that list
   * as the schema demanding those fields and concluded the tool was uncallable.
   * It was, from that runtime.
   */
  describe('an argument sent as null', () => {
    /** Every argument this kind does not take, exactly as such a runtime sends it. */
    const nulled = (except: readonly string[]): Record<string, null> =>
      Object.fromEntries(
        answerArguments()
          .filter((field) => !except.includes(field))
          .map((field) => [field, null]),
      )

    it('is not an argument, so authenticator.secret can be called', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const minted = await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'authenticator.secret', replace: false, ...nulled(['replace']) },
      })

      expect(minted.isError).toBeFalsy()
      await close()
    })

    /** The reporter's second reproduction, which differed only here. */
    it('is not an argument when replace is true either', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const minted = await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'authenticator.secret', replace: true, ...nulled(['replace']) },
      })

      expect(minted.isError).toBeFalsy()
      await close()
    })

    it('reaches a rung that takes arguments without changing what it receives', async () => {
      const challenges = fakeVisionChallenges()
      const colony = { ...fakeColony(), vision: fakeVision(challenges) }
      const registered = await colony.registry.register(
        { name: 'sighted-with-nulls', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
      const { agent, credentials } = registered.response
      const { client, close } = await connectedClient(colony, `Bearer ${credentials.apiKey}`)

      await client.callTool({ name: 'kolonie.academy.challenge', arguments: { kind: 'vision' } })

      const solved = await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: {
          kind: 'vision.solve',
          answer: challenges.expectedAnswerFor(agent.id) ?? '',
          ...nulled(['answer']),
        },
      })

      expect(solved.isError).toBeFalsy()
      expect((solved.structuredContent as { solved: boolean }).solved).toBe(true)
      await close()
    })

    /**
     * **The rejection case, and it is the one this change must not have moved.**
     * `null` stops being an argument; a value does not. An argument that belongs
     * to another kind is refused exactly as before, with the same sentence.
     */
    it('does not make a real foreign argument acceptable', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const refused = await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'pow.solve', nonce: 'abc', publicKey: 'not mine to send here' },
      })

      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain('publicKey')
      await close()
    })

    /** A kind sent as `null` is a kind nobody gave, not a kind nobody serves. */
    it('is no kind at all when the kind itself is null', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const refused = await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: null },
      })

      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain('No kind was given')
      await close()
    })
  })
})
