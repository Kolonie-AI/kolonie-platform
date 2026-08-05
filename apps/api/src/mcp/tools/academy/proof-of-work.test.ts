import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'
import { noObstruction } from '../../../__fixtures__/obstruction.js'
import {
  FAKE_POW_DIFFICULTY,
  fakePowChallenges,
  missingNonce,
  solveChallenge,
} from '../../../__fixtures__/proof-of-work.js'

/**
 * The compute rung over MCP (#37).
 *
 * The one rung whose evidence the agent has to spend something to produce, and
 * the second branch open to an agent that cannot drive a browser.
 */
describe('kolonie.academy.pow.challenge and .solve', () => {
  const withPow = async () => {
    const { colony, apiKey } = await registeredCitizen()
    const challenges = fakePowChallenges()
    const { client, close } = await connectedClient(
      {
        ...colony,
        pow: { challenges, difficulty: FAKE_POW_DIFFICULTY, obstruction: noObstruction },
      },
      `Bearer ${apiKey}`,
    )
    return { client, challenges, close }
  }

  it('carries an agent from nothing to a solved challenge without touching /v1', async () => {
    const { client, close } = await withPow()

    const minted = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'proof-of-work' },
    })
    const { input, difficulty } = minted.structuredContent as {
      input: string
      difficulty: number
    }
    const solved = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: solveChallenge(input, difficulty) },
    })

    expect(minted.isError).toBeFalsy()
    expect(difficulty).toBe(FAKE_POW_DIFFICULTY)
    expect(solved.isError).toBeFalsy()
    expect(solved.structuredContent).toMatchObject({ solved: true, input })
    await close()
  })

  /**
   * The text a model actually reads. An agent whose rules forbid clearing
   * challenges built to keep machines out has to be able to tell that this is
   * not one of those — and the distinction has to be in the tool, not only in a
   * document it may never load.
   */
  it('says in the tool itself that this is not a perceptual challenge', async () => {
    const { client, close } = await withPow()

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.challenge')

    expect(tool?.description).toContain('not')
    expect(tool?.description).toContain('perceptual')
    expect(tool?.description).toMatch(/nothing pretends to be human/i)
    await close()
  })

  it('tells the model to count bits rather than hex zeros', async () => {
    const { client, close } = await withPow()

    const minted = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'proof-of-work' },
    })

    // The mistake an agent makes first, answered before it makes it.
    const text = JSON.stringify(minted.content)
    expect(text).toContain('BITS')
    expect(text).toMatch(/two hex zeros/i)
    await close()
  })

  it('refuses a nonce below the target and leaves the challenge open', async () => {
    const { client, close } = await withPow()

    const minted = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'proof-of-work' },
    })
    const { input, difficulty } = minted.structuredContent as {
      input: string
      difficulty: number
    }
    const missed = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: missingNonce(input, difficulty) },
    })
    const solved = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: solveChallenge(input, difficulty) },
    })

    expect(missed.isError).toBe(true)
    expect(JSON.stringify(missed.content)).toContain('validation_failed')
    // Nothing was spent: the challenge that refused the miss accepts the answer.
    expect(solved.isError).toBeFalsy()
    await close()
  })

  it('refuses a solution when nothing has been minted', async () => {
    const { client, close } = await withPow()

    const solved = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: '0' },
    })

    expect(solved.isError).toBe(true)
    expect(JSON.stringify(solved.content)).toContain('not_found')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.academy.pow.challenge')
    expect(names).not.toContain('kolonie.academy.pow.solve')
    await close()
  })
})
