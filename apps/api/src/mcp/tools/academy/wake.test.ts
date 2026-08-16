import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'

/**
 * The wake mint over MCP, and which of two citizens it is talking to (`#1029`).
 *
 * `wakeChallengeAsText` has both texts and its own file asserts both. What is
 * asserted here is the one thing that file cannot see: that the dispatcher picks
 * the right one. The branch is a single expression reading `agent.skills`, and a
 * single expression is exactly the kind of wiring that regresses without a test
 * — the wrong half of it is a citizen told to hand in a task the platform will
 * refuse, which is the defect this issue was filed about.
 */
describe('kolonie.academy.answer with kind "wake.endpoint"', () => {
  const minting = async (skills: readonly string[]) => {
    const { colony, apiKey, agent } = await registeredCitizen()
    if (skills.length > 0) colony.standing(agent.id, { skills, status: 'citizen' })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'wake.endpoint', url: 'https://agents.example.com/kolonie/wake' },
    })
    await close()

    return { result, text: (result.content as Array<{ text: string }>)[0]?.text ?? '' }
  }

  it('tells a citizen taking the rung to hand in', async () => {
    const { result, text } = await minting([])

    expect(result.isError).toBeFalsy()
    expect(text).toContain('Then hand in with kolonie.tasks.submit')
    expect(text).not.toContain('do not hand it in')
  })

  /**
   * The rotation, which is the case the rung's text had never been written for:
   * `submissions.ts` refuses a passed task with *a pass is final*, so the one
   * instruction the old text gave this citizen was the one that could not work.
   */
  it('tells a holder it is rotating and must not hand in', async () => {
    const { result, text } = await minting(['wake'])

    expect(result.isError).toBeFalsy()
    expect(text).toContain('do not hand it in')
    expect(text).toContain('a pass is final')
    expect(text).not.toContain('Then hand in with kolonie.tasks.submit')
  })

  /**
   * The rejection case for the branch itself. Holding *a* skill is not holding
   * *this* one, and a substring test over the skill list would have said it was.
   */
  it('does not read another skill as the wake one', async () => {
    const { text } = await minting(['keypair', 'mailbox'])

    expect(text).toContain('Then hand in with kolonie.tasks.submit')
  })

  /** The mint still succeeds and still hands over what a handler needs, either way. */
  it('hands over the secret and the handler steps to both', async () => {
    for (const skills of [[], ['wake']]) {
      const { result, text } = await minting(skills)

      expect(result.isError).toBeFalsy()
      expect(text).toContain('What your handler must do:')
      expect(text).toContain('Store that now')
    }
  })
})
