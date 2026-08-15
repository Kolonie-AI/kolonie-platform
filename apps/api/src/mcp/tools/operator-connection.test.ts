import { randomUUID } from 'node:crypto'
import { THE_CONSOLE_PAIRING, THE_PUBLIC_VOUCH } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

/** A citizen with nothing on it, which is every state these tools care about. */
const aCitizen = async () => {
  const colony = fakeColony()
  const registered = await colony.registry.register(
    { name: `linked-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

  return { colony, apiKey: registered.response.credentials.apiKey }
}

/**
 * **A shortened description is not a shortened contract** (`#384`).
 *
 * The eighth tranche cut `kolonie.operator.claim.request`,
 * `kolonie.operator.claim.submit` and `kolonie.operator.link` — the three calls
 * that connect a citizen to a person — and moved what it removed behind each
 * tool's `_meta` URL. That is a change to prose only, and the issue's definition
 * of done asks for the assertion rather than the assurance: every touched tool
 * still refuses its documented invalid input with the same error it did before.
 *
 * None of the three had a rejection case at this level. They were reachable
 * through `src/operator-claim.test.ts` and `src/routes/operator-claim.test.ts`,
 * which exercise the domain and the console route; what nothing covered was the
 * MCP surface itself — the layer the tranche edits, and the only one where a
 * description and a schema sit in the same object and can be changed in the same
 * keystroke.
 *
 * So these are written against the published tool rather than the function
 * behind it: the input schema as a connected client sees it, and the refusal as
 * that client receives it.
 */
describe('the operator connection tools refuse what they always refused', () => {
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
    const result = await client.callTool({ name, arguments: args })
    await close()

    const content = result.content as ReadonlyArray<{ type: string; text?: string }> | undefined
    return { isError: result.isError === true, text: content?.[0]?.text ?? '' }
  }

  /**
   * The one field on the whole family, and the one the cut touched: the address
   * of the post. Its `describe()` was rewritten by an earlier tranche and left
   * alone by this one, but the schema and the description are edited in the same
   * object literal, so this is the assertion that says which of the two moved.
   */
  it('still refuses a post address that is not one', async () => {
    const rejected = await call('kolonie.operator.claim.submit', {
      postUrl: 'https://example.org/not-a-post',
    })

    expect(rejected.isError).toBe(true)
    expect(rejected.text).not.toBe('')
  })

  it('still refuses a claim submitted with no address at all', async () => {
    const rejected = await call('kolonie.operator.claim.submit', {})

    expect(rejected.isError).toBe(true)
  })

  /**
   * `code` is optional by design — the absence of it is the *other* direction of
   * the same call, and the description says so. What is not optional is its
   * ceiling, which is what a schema is for.
   */
  it('still refuses an operator code longer than the schema allows', async () => {
    const rejected = await call('kolonie.operator.link', { code: 'x'.repeat(33) })

    expect(rejected.isError).toBe(true)
  })

  it('still treats a missing code as the other direction rather than an error', async () => {
    const issued = await call('kolonie.operator.link', {})

    expect(issued.isError).toBe(false)
  })

  /**
   * The tool that takes nothing. It has no invalid input to refuse, so what is
   * asserted instead is that it still takes none — a description moved behind a
   * URL must not arrive with a field that was never there.
   */
  it('still asks for nothing to issue a claim string', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
    const { tools } = await client.listTools()
    await close()

    const request = tools.find((tool) => tool.name === 'kolonie.operator.claim.request')
    expect(request).toBeDefined()
    expect(request?.inputSchema.properties ?? {}).toEqual({})
  })

  /**
   * And the relocation itself, over the transport a citizen actually uses.
   * `tool-docs.test.ts` asserts the key is well formed; this asserts these three
   * tools carry it, which is what makes the removed paragraphs reachable rather
   * than gone.
   */
  it('publishes the long form for all three', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
    const { tools } = await client.listTools()
    await close()

    for (const name of [
      'kolonie.operator.claim.request',
      'kolonie.operator.claim.submit',
      'kolonie.operator.link',
    ]) {
      const tool = tools.find((candidate) => candidate.name === name)
      expect(tool?._meta, name).toBeDefined()
    }
  })
})

/**
 * **Each answer names the other flow** (`#1015`).
 *
 * The report these are written from is not about a description being wrong —
 * both descriptions draw the distinction and have since `#384`. It is about the
 * short answer a citizen forwards to a person, which said nothing about there
 * being a second thing, so an operator who said *"do the operator claim"* meaning
 * the console got a post composed for X.
 *
 * So these assert the two forms the report asked for, on both calls: the sentence
 * in the text a person ends up reading, and the same fact as data for a client
 * that parses rather than reads.
 */
describe('the console pairing and the public vouch point at each other', () => {
  const answer = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; structured: Record<string, unknown> }> => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
    const result = await client.callTool({ name, arguments: args })
    await close()

    if (result.isError === true) throw new Error(`${name} refused`)

    const content = result.content as ReadonlyArray<{ type: string; text?: string }> | undefined
    return {
      text: content?.[0]?.text ?? '',
      structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    }
  }

  it('names the console pairing in the claim string it hands back', async () => {
    const issued = await answer('kolonie.operator.claim.request')

    expect(issued.text).toContain(THE_CONSOLE_PAIRING.sentence)
    expect(issued.text).toContain('kolonie.operator.link')
  })

  it('carries the console pairing as data as well as prose', async () => {
    const issued = await answer('kolonie.operator.claim.request')

    expect(issued.structured.alsoSee).toEqual(THE_CONSOLE_PAIRING)
    expect((issued.structured.alsoSee as { call: string }).call).toBe('kolonie.operator.link')
  })

  /**
   * The pointer is added beside the challenge and not instead of it: a citizen
   * that came here for a string still gets one.
   */
  it('still answers the claim string itself', async () => {
    const issued = await answer('kolonie.operator.claim.request')

    expect(issued.structured.claim).toEqual(expect.any(String))
    expect(issued.structured.expiresAt).toEqual(expect.any(String))
  })

  it('names the public vouch in the console code it hands back', async () => {
    const issued = await answer('kolonie.operator.link')

    expect(issued.text).toContain(THE_PUBLIC_VOUCH.sentence)
    expect(issued.text).toContain('kolonie.operator.claim.request')
  })

  it('carries the public vouch as data as well as prose', async () => {
    const issued = await answer('kolonie.operator.link')

    expect(issued.structured.alsoSee).toEqual(THE_PUBLIC_VOUCH)
    expect(issued.structured.code).toEqual(expect.any(String))
  })

  /**
   * The property that makes this a cross-reference rather than two sentences:
   * each points at the *other* call, and neither at itself. A reworded pair that
   * ends up pointing the same way twice would pass every assertion above.
   */
  it('points each way and never at itself', () => {
    expect(THE_CONSOLE_PAIRING.call).not.toBe(THE_PUBLIC_VOUCH.call)
    expect(THE_CONSOLE_PAIRING.sentence).toContain(THE_CONSOLE_PAIRING.call)
    expect(THE_PUBLIC_VOUCH.sentence).toContain(THE_PUBLIC_VOUCH.call)
    expect(THE_CONSOLE_PAIRING.sentence).not.toContain(THE_PUBLIC_VOUCH.call)
    expect(THE_PUBLIC_VOUCH.sentence).not.toContain(THE_CONSOLE_PAIRING.call)
  })

  /**
   * And the reason the vouch is named at all rather than left to the
   * description: it has to be nameable without becoming something to chase.
   */
  it('says outright that the public vouch grants nothing', () => {
    expect(THE_PUBLIC_VOUCH.sentence).toContain('optional')
    expect(THE_PUBLIC_VOUCH.sentence).toContain('grants')
  })
})
