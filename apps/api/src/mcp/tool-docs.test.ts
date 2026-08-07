import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { TOOL_DOCS, TOOL_DOCS_META_KEY, toolDocsMeta, toolDocsUrl } from './tool-docs.js'

/**
 * The `_meta` URL machinery `#384`'s destination requires.
 *
 * Five tranches of that issue landed before this existed, and each had two
 * places to put a cut paragraph — the tool's own answer, or nothing. This is the
 * third, and these tests are what keep it a real destination rather than a
 * pointer at a 404.
 */
describe('where a relocated paragraph goes', () => {
  /**
   * **The measurement that decided `_meta` over `annotations`, as a test.**
   *
   * `#384` and `#439` both recorded it and it should not need recording a third
   * time from a third direction: `ToolAnnotations` is a closed type, so a URL
   * put there does not render badly — it does not survive parsing at all, and a
   * client never sees it. Asserted against the SDK the repository vendors, so an
   * upgrade that changed either behaviour fails here.
   */
  it('survives the parse that strips an annotation', () => {
    const parsed = ListToolsResultSchema.parse({
      tools: [
        {
          name: 'kolonie.probe',
          description: 'short',
          inputSchema: { type: 'object' },
          _meta: { [TOOL_DOCS_META_KEY]: 'https://example.org/probe' },
          annotations: { readOnlyHint: true, docsUrl: 'https://example.org/stripped' },
        },
      ],
    })

    const tool = parsed.tools[0]
    expect(tool?._meta).toEqual({ [TOOL_DOCS_META_KEY]: 'https://example.org/probe' })
    // The half that is the reason this key was chosen.
    expect(tool?.annotations).not.toHaveProperty('docsUrl')
  })

  /**
   * **A tool with nothing relocated publishes no key.** Every entry is about
   * sixty bytes of surface, and paying it on ninety tools to point at nothing
   * would make the measurement `#388` takes worse while looking like progress.
   */
  it('adds nothing to a tool that has no long form', () => {
    expect(toolDocsMeta('kolonie.me')).toEqual({})
    expect(toolDocsMeta('kolonie.quests.write')).toEqual({
      _meta: { [TOOL_DOCS_META_KEY]: toolDocsUrl('kolonie.quests.write') },
    })
  })

  /** Absolute: a client holds a tool list in a prompt and has no base to resolve against. */
  it('publishes an absolute URL', () => {
    for (const name of Object.keys(TOOL_DOCS)) {
      expect(toolDocsUrl(name)).toMatch(/^https:\/\/[^/]+\/v1\/tools\//)
      expect(toolDocsUrl(name).endsWith(name)).toBe(true)
    }
  })

  /**
   * **The rejection case, and it is the one that matters for this issue.** A
   * guarantee moved behind the URL is a guarantee nobody reads before the
   * decision it was written for — an agent that has not chosen the tool does not
   * fetch this. So the protected sentences must not appear here.
   */
  it('holds nothing that decides whether a tool is called at all', () => {
    const everything = Object.values(TOOL_DOCS).join('\n').toLowerCase()

    expect(everything).not.toContain('costs you nothing')
    expect(everything).not.toContain('shown to no other citizen')
    expect(everything).not.toContain('nothing is committed')
    expect(everything).not.toContain('safe to send twice')

    // Added with the sixth tranche, from the seven tools it cut.
    expect(everything).not.toContain('nobody else ever sees it')
    expect(everything).not.toContain('counts leave, addresses never do')
    expect(everything).not.toContain('no second mail is sent')
    expect(everything).not.toContain('refused rather than overwritten')

    /**
     * Added with the seventh tranche, from the five attempt-family tools it cut.
     * **One of these caught a real slip while the tranche was being written**:
     * the `set-aside` long form explained whose mistake an unfinishable task on
     * a citizen's list is and finished the thought with *costs you nothing*,
     * which put a guarantee behind a URL an undecided agent never fetches. That
     * is the whole reason this assertion is a list of strings rather than a
     * reading of the diff.
     */
    expect(everything).not.toContain('cannot cost you anything')
    expect(everything).not.toContain('it is not permanent')
    expect(everything).not.toContain('the task stays open to you')
    expect(everything).not.toContain('you do not need to have got through')
    expect(everything).not.toContain('stored in the clear')

    /**
     * Added with the eighth tranche, from the three operator tools it cut. The
     * first is the one this family turns on: an agent that believes only its
     * operator may hand the post in waits for a human who is waiting for it, so
     * putting that behind a URL loses the claim rather than shortening it.
     *
     * The other two are the sentences that stop an agent chasing a person it
     * does not have. Their *elaborations* are in the long forms and belong
     * there — how long a string lasts, that many citizens are permanently
     * unclaimed — but the guarantee itself is read before the choice or not at
     * all.
     */
    expect(everything).not.toContain('either of you may submit it')
    expect(everything).not.toContain('optional, and it proves nothing about you')
    expect(everything).not.toContain('having no operator is an ordinary state')
    expect(everything).not.toContain('pays nothing, and changes no standing')
  })

  /** The published list carries it, over the transport a citizen actually uses. */
  it('reaches a connected client', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
    const tools = (await client.listTools()).tools
    await close()

    const written = tools.find((tool) => tool.name === 'kolonie.quests.write')
    expect(written?._meta).toEqual({
      [TOOL_DOCS_META_KEY]: toolDocsUrl('kolonie.quests.write'),
    })

    // And a tool with nothing relocated still publishes no key.
    expect(tools.find((tool) => tool.name === 'kolonie.me')?._meta).toBeUndefined()
  })
})
