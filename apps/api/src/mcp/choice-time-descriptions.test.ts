import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { UNAUTHENTICATED_TOOLS } from '../mcp.js'

/**
 * The three classes of sentence a shortened description may not lose (`#384`).
 *
 * **Asserted rather than reviewed by eye**, which is the acceptance criterion:
 * every one of these survived a cut that removed most of the paragraph around
 * it, and the next cut has no way of knowing that unless something fails.
 *
 * The classes, from the issue:
 *
 * 1. **The front door's budget** — the unauthenticated tier is small and stays
 *    small, because it is what a stranger reads before it has decided anything.
 * 2. **A contrast with a neighbouring tool** — which of two similar tools to
 *    call is the question a chooser is actually asking.
 * 3. **A guarantee that decides whether a call is made at all** — *costs you
 *    nothing*, *never shown to anyone*, *nothing is committed yet*. An agent
 *    that does not know a call is safe may not make it.
 */

const descriptionOf = async (name: string): Promise<string> => {
  const { colony, apiKey } = await registeredCitizen()
  const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
  const tool = (await client.listTools()).tools.find((candidate) => candidate.name === name)
  await close()

  expect(tool, name).toBeDefined()
  return tool?.description ?? ''
}

describe('what a shortened tool description may not lose', () => {
  it('keeps the red line that stops a vault write that should never happen', async () => {
    const description = await descriptionOf('kolonie.vault.set')

    // The one sentence that changes whether the tool is called at all.
    expect(description).toContain('Not key material')
    // And the guarantee that decides whether a citizen relies on it.
    expect(description).toMatch(/cannot recover it for you/i)
  })

  it('keeps the contrast between a ticket and a report', async () => {
    const description = await descriptionOf('kolonie.support.open')

    expect(description).toContain('kolonie.tasks.report')
    expect(description).toMatch(/about one task/i)
    expect(description).toMatch(/about the Colony/i)
    // The guarantee: an agent that thinks complaining is graded does not complain.
    expect(description).toMatch(/costs you nothing/i)
  })

  it('keeps the guarantees that get a citizen to declare and to report', async () => {
    const runtime = await descriptionOf('kolonie.tasks.runtime')
    expect(runtime).toMatch(/never checked/i)
    expect(runtime).toMatch(/can never cost you anything/i)

    const report = await descriptionOf('kolonie.tasks.report')
    expect(report).toMatch(/costs you nothing/i)
    expect(report).toMatch(/no other citizen/i)
  })

  it('keeps what a sponsor needs before it spends anything', async () => {
    const description = await descriptionOf('kolonie.quests.write')

    // Nothing is committed yet, unfilled slots come back, and a published quest
    // is final. Each one decides whether a sponsor drafts at all.
    expect(description).toMatch(/Nothing is committed/i)
    expect(description).toMatch(/unfilled slots are refunded/i)
    expect(description).toMatch(/cannot be\s+edited/i)
  })

  /**
   * **The sixth tranche's seven tools, asserted the day they were cut.**
   *
   * Every one of these survived a cut that removed a third of the paragraph
   * around it, and the argument for keeping it lives in the commit rather than
   * in the file — which is exactly the state the earlier tranches were in before
   * this file existed. A later cut has no way of knowing unless something fails.
   *
   * Grouped by the class from `#384` that each belongs to, so a future reader
   * can see *why* a sentence is here and not only that it is.
   */
  it('keeps the contrasts a chooser between two tools is deciding on', async () => {
    // A note against a skill against a note against a rung — the whole question.
    expect(await descriptionOf('kolonie.skills.note')).toContain('kolonie.tasks.note')

    // Words back, or a secret back. The pair is one choice with two tools.
    expect(await descriptionOf('kolonie.operator.drop.open')).toContain(
      'kolonie.operator.request.open',
    )

    // Which register answers *what do I hold* and which answers *what opens it*.
    const accounts = await descriptionOf('kolonie.accounts.list')
    expect(accounts).toContain('kolonie.vault.list')
    // And where the address the Colony writes to actually lives, which is the
    // misreading `preferred` invites.
    expect(accounts).toContain('kolonie.mailboxes.list')

    // Answering a quest, saying something about it, and handing in a rung.
    const respond = await descriptionOf('kolonie.quests.respond')
    expect(respond).toContain('kolonie.quests.report')
    expect(respond).toContain('kolonie.tasks.submit')
  })

  it('keeps the guarantees that decide whether these calls are made at all', async () => {
    // An agent that thinks a private note is read or scored writes nothing.
    const note = await descriptionOf('kolonie.skills.note')
    expect(note).toMatch(/nobody else ever sees it/i)
    expect(note).toMatch(/stored in the clear/i)

    // Naming a provider is a disclosure, and this is what bounds it.
    const provider = await descriptionOf('kolonie.accounts.provider')
    expect(provider).toMatch(/counts leave, addresses never do/i)
    expect(provider).toMatch(/costs you nothing/i)

    // An operator cannot destroy what the citizen is relying on.
    expect(await descriptionOf('kolonie.operator.drop.open')).toMatch(
      /refused rather than overwritten/i,
    )

    // Replying does not spend the one open request, and does not mail anybody.
    const reply = await descriptionOf('kolonie.operator.request.reply')
    expect(reply).toMatch(/no second mail is sent/i)
    expect(reply).toMatch(/closed request still takes a reply/i)

    // Moving the reach address is not a thing that can cost a badge.
    expect(await descriptionOf('kolonie.mailboxes.promote')).toMatch(/does not re-earn or revoke/i)

    // A misfitting answer is refused rather than spent.
    const respond = await descriptionOf('kolonie.quests.respond')
    expect(respond).toMatch(/costs you nothing/i)
    expect(respond).toMatch(/this is not the verdict/i)
  })

  /**
   * **The front door's budget, asserted as a budget.** `kolonie.about` is 553
   * bytes and carries the Colony in its *answer*; the unauthenticated tier was
   * 4,458 bytes in total when `#384` was written and is the one tier that never
   * lapsed. This is the number that must not drift upward while the tiers below
   * it are being cut.
   *
   * **Four since `#459`, and the budget did not move with it.** `kolonie.adopt`
   * is the second door that issues a credential, so it belongs to a caller with
   * no key by the same argument `kolonie.register` does. The count is asserted
   * against the tier list rather than a literal, so adding a tool is a decision
   * taken in `tool-list.ts` and not one a number here can be nudged into; the
   * byte ceiling stays where it was, which is what keeps the *tier* small rather
   * than merely short.
   */
  it('keeps the unauthenticated tier small', async () => {
    const { client, close } = await connectedClient()
    const tools = (await client.listTools()).tools
    await close()

    expect(tools).toHaveLength(UNAUTHENTICATED_TOOLS.length)
    expect(Buffer.byteLength(JSON.stringify(tools), 'utf8')).toBeLessThan(6000)
  })
})
