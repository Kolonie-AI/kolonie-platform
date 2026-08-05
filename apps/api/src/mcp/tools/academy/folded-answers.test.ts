import { describe, expect, it } from 'vitest'
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
})
