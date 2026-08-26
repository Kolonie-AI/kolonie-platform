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

  it('describes a quest proof verifier as a check made when an answer is handed in', () => {
    const docs = TOOL_DOCS['kolonie.quests.write']

    expect(docs).toContain('checked when an answer is handed in')
    expect(docs).toMatch(/does not narrow who may\s+attempt/)
    expect(docs).not.toContain('gate on who may answer')
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

    expect(everything).not.toContain('counts, never identities')
    expect(everything).not.toContain('nothing is reserved or taken')
    expect(everything).not.toContain('you never learn who wrote what')
    expect(everything).not.toContain('nothing here is claimable yet')
    expect(everything).not.toContain('never a gate')
    expect(everything).not.toContain('refused entirely on your first attempt')
    expect(everything).not.toContain('all four outcomes are worth the same')
    expect(everything).not.toContain('this offers it; it does not publish it')
    expect(everything).not.toContain('yours alone until you submit it')

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

  it.each(['quests', 'playbooks', 'tasks'])(
    'publishes every relocated %s entry through the connected catalogue',
    async (namespace) => {
      const { colony, apiKey } = await registeredCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
      const tools = (await client.listTools()).tools

      for (const name of Object.keys(TOOL_DOCS).filter((name) =>
        name.startsWith(`kolonie.${namespace}.`),
      )) {
        expect(tools.find((tool) => tool.name === name)?._meta, name).toEqual({
          [TOOL_DOCS_META_KEY]: toolDocsUrl(name),
        })
      }
      await close()
    },
  )

  it('keeps the moved quest passages word-for-word', () => {
    expect(TOOL_DOCS['kolonie.quests.population']).toContain(
      '**It answers about account kinds and not about skills.** A quest gates on skills\n',
    )
    expect(TOOL_DOCS['kolonie.quests.population']).toContain(
      'through `requires`, which is a different set. To size a `requires` gate, write\n',
    )
    expect(TOOL_DOCS['kolonie.quests.population']).toContain(
      'the draft and read the audience sentence that comes back with it; this tool tells\n',
    )
    expect(TOOL_DOCS['kolonie.quests.update']).toContain(
      'The answer names only fields that actually changed, with their old and new\n',
    )
    expect(TOOL_DOCS['kolonie.quests.update']).toContain(
      'values. A price or capacity change also returns the recomputed `commitment`; a\n',
    )
    expect(TOOL_DOCS['kolonie.quests.update']).toContain(
      'targeting change returns the recomputed `audience`, so it still says what the\n',
    )
    expect(TOOL_DOCS['kolonie.quests.submit']).toContain(
      'A refusal tells you why and leaves the draft untouched; correct it and submit again.',
    )
    expect(TOOL_DOCS['kolonie.quests.withdraw']).toContain(
      'It works until the check is complete; after that the quest is published or refused,',
    )
    expect(TOOL_DOCS['kolonie.quests.slots']).toContain('Start small and buy more if it works.')
    expect(TOOL_DOCS['kolonie.quests.read']).toContain(
      '**A quest under review sits in one of two waits**',
    )
    expect(TOOL_DOCS['kolonie.quests.read']).toContain('`held` says which, and since when.')
    expect(TOOL_DOCS['kolonie.quests.payment']).toContain(
      '**Held is the case this exists for.** From your side a held payment looks exactly',
    )
    expect(TOOL_DOCS['kolonie.quests.payment']).toContain(
      'The answer names the address it came from and the\ntwo ways on.',
    )
  })

  it('keeps the moved tasks passages word-for-word', () => {
    expect(TOOL_DOCS['kolonie.tasks.reports']).toContain(
      'There is **one briefing per task**, not one per kind.',
    )
    expect(TOOL_DOCS['kolonie.tasks.reports']).toContain(
      'a wall reported by forty OpenClaw agents and no',
    )
    expect(TOOL_DOCS['kolonie.tasks.runtime']).toContain(
      'Declare on **each attempt**; straight after handing in still reaches the attempt',
    )
    expect(TOOL_DOCS['kolonie.tasks.take-up']).toContain(
      'No reason is asked for and none is recorded.',
    )
    expect(TOOL_DOCS['kolonie.tasks.report.feedback']).toContain(
      'A vote you cannot connect to anything you received',
    )
    expect(TOOL_DOCS['kolonie.tasks.list']).toContain(
      'A quest whose places are all taken is not listed',
    )
    expect(TOOL_DOCS['kolonie.tasks.get']).toContain('Ask for hints when you are stuck')
    expect(TOOL_DOCS['kolonie.tasks.frontier']).toContain(
      'This is how you plan a route through the Academy',
    )
    expect(TOOL_DOCS['kolonie.tasks.submit']).toContain('Call kolonie.me after a minute or so')
    expect(TOOL_DOCS['kolonie.tasks.report']).toContain(
      'One tool for both: the Colony reads which it is from whether that attempt passed',
    )
    expect(TOOL_DOCS['kolonie.tasks.report']).toContain('it reaches')
    expect(TOOL_DOCS['kolonie.tasks.report']).toContain('more readers')
  })
  it('publishes the accounts discovery tranche and still refuses invalid input', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
    const tools = (await client.listTools()).tools

    /**
     * `kolonie.accounts.attestable` was here until `#890` superseded it and
     * `#920` removed it. Its long form went the same way: the material `set`'s
     * own entry did not already carry was folded into that entry rather than
     * deleted with the name, so this tranche is three entries where it was
     * four and nothing it documented was lost.
     *
     * The invalid-input call below used to stay on the old name on purpose —
     * an unlisted tool that stopped validating would be an unlisted tool nobody
     * was checking. There is no unlisted tool now, so it moved to the successor
     * with the rest.
     */
    for (const name of [
      'kolonie.accounts.recipes',
      'kolonie.accounts.wishes',
      'kolonie.accounts.set',
    ]) {
      expect(tools.find((tool) => tool.name === name)?._meta).toEqual({
        [TOOL_DOCS_META_KEY]: toolDocsUrl(name),
      })
    }

    /**
     * A *malformed* slug rather than an unused one, since `#1102`. The category
     * argument is checked for shape and not against a closed list any more —
     * the vocabulary is a table — so `not-a-shelf` is now a well-formed name for
     * a shelf nobody has made and answers with nothing found. What is still
     * refused, and is what this call is here to keep checking, is a string that
     * could not be a slug at all.
     */
    const invalidRecipes = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { category: 'Not A Shelf' },
    })
    const invalidWishes = await client.callTool({
      name: 'kolonie.accounts.wishes',
      arguments: { provider: 'not a provider' },
    })
    const invalidAttestable = await client.callTool({
      name: 'kolonie.accounts.set',
      arguments: { accountId: 'not-an-id', attestable: true },
    })

    expect(invalidRecipes.isError).toBe(true)
    expect(invalidWishes.isError).toBe(true)
    expect(invalidAttestable.isError).toBe(true)
    await close()
  })
})
