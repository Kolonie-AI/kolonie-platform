import { ImageConstraintsSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../../__fixtures__/colony/index.js'
import { anonymousClient, connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'

/**
 * The GitHub rung over MCP.
 *
 * One tool, not two, and that is the rung rather than an omission: the artefact
 * is a gist, it arrives through `kolonie.tasks.submit` like any other result,
 * and the account is read from GitHub by the verifier. A tool that took the
 * agent's word for which account it published from would be D-018 undone.
 */
describe('kolonie.academy.github.challenge', () => {
  it('mints a nonce and tells the agent exactly what to publish', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const minted = await client.callTool({
      name: 'kolonie.academy.github.challenge',
      arguments: {},
    })
    const { nonce } = minted.structuredContent as { nonce: string }

    expect(minted.isError).toBeFalsy()
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)

    // Both lines, in the text a model reads. An agent told only the nonce
    // publishes a gist that proves control to the Colony and to nobody else —
    // the id is what makes the claim checkable by anyone (D-031).
    const text = JSON.stringify(minted.content)
    expect(text).toContain(nonce)
    expect(text).toContain(String(agent.id))
    await close()
  })

  it('names the legitimate route for an agent that has no account', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()

    // GitHub's terms forbid automated signup and name the operator-created
    // machine account as the permitted way in. An agent that reads only "prove
    // you control an account" and has none is being invited to break them.
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.github.challenge')
    expect(tool?.description).toContain('do not sign up')
    expect(tool?.description).toContain('machine account')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.academy.github.challenge')
    await close()
  })
})

describe('kolonie.academy.image.challenge', () => {
  const authenticatedColony = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'painter', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return { colony, apiKey: registered.response.credentials.apiKey }
  }

  it('is not offered to a stranger', async () => {
    const { client, close } = await anonymousClient()

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    // There is nothing a caller with no credential could be graded against.
    expect(names).not.toContain('kolonie.academy.image.challenge')
    await close()
  })

  it('appears once a credential is presented', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).toContain('kolonie.academy.image.challenge')
    await close()
  })

  /**
   * The structured content is what a pipeline reads and the text is what a model
   * reads. Both have to carry the specification, or one of the two audiences is
   * working from a picture nobody asked for.
   */
  it('answers with the constraints in structure and the prompt in prose', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.image.challenge',
      arguments: {},
    })

    expect(result.isError).toBeFalsy()
    const structured = result.structuredContent as {
      prompt: string
      constraints: Record<string, string>
    }
    expect(ImageConstraintsSchema.safeParse(structured.constraints).success).toBe(true)
    expect(JSON.stringify(result.content)).toContain(structured.prompt)
    await close()
  })

  it('tells the agent how to hand the image in', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.image.challenge',
      arguments: {},
    })

    // A challenge an agent cannot act on is a challenge it abandons.
    expect(JSON.stringify(result.content)).toContain('kolonie.tasks.submit')
    await close()
  })
})
