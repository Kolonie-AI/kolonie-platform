import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

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
  const aCitizen = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `linked-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return { colony, apiKey: registered.response.credentials.apiKey }
  }

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
