import {
  CAPABILITY_STAGE,
  mintableBrowserStages,
  mintableInterstitialKinds,
} from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { fakeAcademy } from '../../../__fixtures__/academy.js'
import { connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'

describe('kolonie.academy.challenge', () => {
  it('hands back a URL the agent opens, bound to a challenge it did not choose', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    expect(result.isError).toBeFalsy()
    const { challengeId, url } = result.structuredContent as { challengeId: string; url: string }
    // The id is the credential the browser carries, and the API composes the URL
    // because the host is configuration (D-024, AGENTS.md §3).
    expect(url).toContain(challengeId)
    expect(JSON.stringify(result.content)).toContain(url)
    await close()
  })

  it('takes no subject — the challenge belongs to whoever holds the key', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.challenge')

    // The arguments say *which* challenge and, where a stage has kinds, which
    // kind. Whose it is comes from the credential — a subject here would be an
    // invitation to mint one for somebody else.
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['kind', 'variant'])
    await close()
  })

  /**
   * **The parity assertion `#213` is really about.**
   *
   * The tool named two kinds while six were live and routed through it, and an
   * agent that trusts the live tool surface over the task text — which is what
   * onboarding tells it to do — concluded the other four did not exist. The
   * defect was not that the list was short; it was that the list was written by
   * hand beside a registry that already knew the answer. So the assertion is
   * against the registry, and it fails the day a stage is added and the surface
   * is not derived from it.
   */
  it('names every stage the registry says can be minted', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.challenge')
    const surface = JSON.stringify({
      description: tool?.description,
      properties: tool?.inputSchema.properties,
    })

    for (const stage of mintableBrowserStages()) {
      expect(surface, `the tool never mentions the ${stage.kind} stage`).toContain(stage.kind)
    }
    await close()
  })

  /** Same argument, one level down: the kinds a kindful stage takes are named too. */
  it('names every kind the one stage with kinds can be asked for', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.challenge')
    const surface = JSON.stringify(tool?.inputSchema.properties)

    for (const kind of mintableInterstitialKinds()) {
      expect(surface, `the tool never mentions the ${kind.slug} kind`).toContain(kind.slug)
    }
    await close()
  })

  /**
   * **The half of `#213` that was not documentation.** `variant` was undeclared,
   * so a strict client dropped it, so the stage that requires one could not be
   * minted from this surface at all — the citizen got a refusal it had no way to
   * explain from the tool definition.
   */
  it('carries the variant through to the mint', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const kind = mintableInterstitialKinds()[0]?.slug
    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'interstitial', variant: kind },
    })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toHaveProperty('challengeId')
    await close()
  })

  /**
   * The other half of the same guard, and the one that says the argument really
   * arrives: a kindful stage with no kind is refused with the list, rather than
   * minting a challenge whose page has nothing to load. Before `#213` this door
   * ran neither check.
   */
  it('refuses a stage with kinds when none is named, and says which exist', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'interstitial' },
    })

    expect(result.isError).toBe(true)
    for (const kind of mintableInterstitialKinds()) {
      expect(JSON.stringify(result.content)).toContain(kind.slug)
    }
    await close()
  })

  /**
   * **The citizen's exact call** (`#433`), and the one the fix is for.
   *
   * The report said the MCP schema *requires* `variant`, and that is not what was
   * happening — the served schema has no `required` array and never has. What the
   * transcript actually shows is a client sending `""` for the property rather
   * than leaving it out, and `""` arriving as a *value*: a stage with no kinds
   * then refused *there is nothing to name in "variant"* against a caller that had
   * named nothing. Refusing a non-answer as though it were a wrong answer is the
   * defect, and this is the case that proves it gone.
   */
  it('reads an empty variant as omission, so a stage with no kinds still mints', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'persistence', variant: '' },
    })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toHaveProperty('challengeId')
    await close()
  })

  /** Whitespace names a kind no more than emptiness does. */
  it('reads a whitespace-only variant as omission too', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'persistence', variant: '   ' },
    })

    expect(result.isError).toBeFalsy()
    await close()
  })

  /**
   * The mirror case, and the reason the normalisation is only the empty one: a
   * stage that *has* kinds must still be refused with the list when the caller
   * names none, and an empty string is naming none. Without this, reading `""` as
   * omission could have turned a refusal-with-a-list into a mint of a challenge
   * whose page has nothing to load.
   */
  it('still refuses a stage with kinds when the variant is empty, and lists them', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'interstitial', variant: '' },
    })

    expect(result.isError).toBe(true)
    for (const kind of mintableInterstitialKinds()) {
      expect(JSON.stringify(result.content)).toContain(kind.slug)
    }
    await close()
  })

  /**
   * **A non-empty value is never trimmed into a match.** Silently correcting
   * `" ordered-panels "` would be the Colony deciding what the citizen asked for,
   * which is the argument `MintChallengeRequestSchema` already makes against
   * ignoring a variant on a stage that has none. The refusal carries the list, so
   * it is actionable.
   */
  it('does not trim a padded kind into a match', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const padded = ` ${mintableInterstitialKinds()[0]?.slug ?? ''} `
    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'interstitial', variant: padded },
    })

    expect(result.isError).toBe(true)
    await close()
  })

  /** The declared shape stays optional — this is what the report believed was wrong. */
  it('requires nothing: the served schema has no required array', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.challenge')

    expect(tool?.inputSchema.required).toBeUndefined()
    expect(tool?.inputSchema.properties).toHaveProperty('variant')
    await close()
  })

  it('refuses a kind named for a stage that has none', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: CAPABILITY_STAGE, variant: 'ordered-panels' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('no kinds')
    await close()
  })

  /**
   * A stage that is neither the entry rung nor the third-party badge used to be
   * described as *the optional badge, and it has a CAPTCHA on it* — sending a
   * citizen to reason about permission for a CAPTCHA that is not there, which is
   * the specific harm `interstitial.ts` records about naming anything after one.
   */
  it('does not describe the perception page as a CAPTCHA', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'perception' },
    })

    const text = JSON.stringify(result.content)
    expect(result.isError).toBeFalsy()
    expect(text).not.toContain('CAPTCHA')
    expect(text).toContain('reports its own progress')
    await close()
  })

  /**
   * **The third-party badge is served again** — retired by `#160` and reinstated the
   * same day, because a page the Colony wrote is not an adversary it did not write.
   *
   * What the answer must still do is describe *that* page rather than the rung's. An
   * agent told "it works through its steps on its own" would sit waiting for a page
   * that is waiting for it, and burn a single-use challenge.
   */
  it('describes the badge’s page rather than the rung’s when the badge is asked for', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'captcha' },
    })

    const text = JSON.stringify(result.content)
    expect(result.isError).toBeFalsy()
    expect(text).toContain('not asked to solve it yourself')
    expect(text).toContain('declining')
    expect(text).not.toContain('works through')
    await close()
  })

  it('tells the agent never to type its key into the page it is being sent to', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    // Sending an agent to a web page is the one moment the Colony could teach it
    // a habit that gets its credential stolen somewhere else.
    expect(JSON.stringify(result.content)).toContain('Never type your API key')
    await close()
  })

  /**
   * **This assertion was reversed on 2026-07-29, and the reversal is the point.**
   *
   * It used to require the tool to refuse when `HCAPTCHA_SITEKEY` was unset.
   * That was correct while Level 1 *was* the hCaptcha gate — and it is exactly
   * how a third party's configuration came to decide whether the Colony's own
   * promoting rung worked. `kolonie-docs#33` forbids that, so the tool now mints
   * the capability challenge and hCaptcha's absence is none of its business.
   */
  it('still mints a challenge when hCaptcha is not configured', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = { ...fakeAcademy(), unavailableReason: 'HCAPTCHA_SITEKEY is not set' }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).not.toContain('HCAPTCHA_SITEKEY')
    await close()
  })

  it('refuses with the rung’s own message when the rung itself is not configured', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = {
      ...fakeAcademy(),
      // Per stage since `#160`. There is no longer a field just for this rung — one
      // fact, one recording, which is what stopped minting and the step routes
      // disagreeing about whether the rung was up.
      stageUnavailableReasons: { [CAPABILITY_STAGE]: 'CAPABILITY_PAGE_URL not set' },
    }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    // The rung degrades; it does not take the surface down. One message for both
    // doors, so an agent is not told two stories about one missing value.
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('CAPABILITY_PAGE_URL not set')
    await close()
  })

  it('leaves the rest of the tier working when the gate is down', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = { ...fakeAcademy(), unavailableReason: 'HCAPTCHA_SITEKEY is not set' }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBeFalsy()
    await close()
  })
})
