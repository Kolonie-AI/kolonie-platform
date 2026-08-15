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

/**
 * The description **and** the argument shape, as one string (`#890`).
 *
 * A consolidated tool carries per-field guarantees the eight tools it replaced
 * each carried in a description of their own — *counts leave, addresses never
 * do* is now a sentence about the `provider` field rather than about a tool.
 * The class `#384` protects is the same class wherever it is written, so the
 * assertion reads everything the published entry puts in front of a chooser.
 */
const publishedTextOf = async (name: string): Promise<string> => {
  const { colony, apiKey } = await registeredCitizen()
  const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)
  const tool = (await client.listTools()).tools.find((candidate) => candidate.name === name)
  await close()

  expect(tool, name).toBeDefined()
  return `${tool?.description ?? ''}\n${JSON.stringify(tool?.inputSchema ?? {})}`
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
    /**
     * The seventh tranche cut this description by 252 bytes and these two are
     * what it could not cut (`#384`). The first removes a precondition a citizen
     * would otherwise assume and fall foul of; the second is the safe-to-call-
     * twice guarantee, which decides whether an agent that is unsure risks the
     * call at all.
     */
    expect(report).toMatch(/do not need to have got through/i)
    expect(report).toMatch(/one report per attempt/i)
  })

  /**
   * The attempt family, cut in the seventh tranche (`#384`).
   *
   * **These four are one another's neighbours**, which is why they are asserted
   * together: every one of them is a call a citizen makes about a task it is not
   * going to finish, and getting the wrong one is the ordinary mistake rather
   * than an exotic one. Each cut removed most of the paragraph around the
   * sentences below.
   */
  it('keeps what tells the four attempt calls apart, and what makes each safe', async () => {
    const setAside = await descriptionOf('kolonie.tasks.set-aside')
    // The contrast — this is the pair a chooser confuses.
    expect(setAside).toContain('kolonie.tasks.decline')
    // And the guarantee that makes it a decision rather than a commitment.
    expect(setAside).toMatch(/not permanent/i)
    expect(setAside).toContain('kolonie.tasks.take-up')

    const decline = await descriptionOf('kolonie.tasks.decline')
    expect(decline).toContain('kolonie.tasks.set-aside')
    expect(decline).toMatch(/costs you nothing/i)
    // Without this a citizen reads declining as spending the task.
    expect(decline).toMatch(/task stays open to you/i)

    const operator = await descriptionOf('kolonie.tasks.operator')
    // An agent that believes silence is not reportable does not report it.
    expect(operator).toMatch(/got nothing" is a real answer/i)
    expect(operator).toMatch(/cannot cost you anything/i)

    const note = await descriptionOf('kolonie.tasks.note')
    // The contrast with the channel whose whole purpose is the opposite.
    expect(note).toContain('kolonie.tasks.report')
    expect(note).toMatch(/nobody else ever sees it/i)
    // The red line that stops a call that should not be made.
    expect(note).toMatch(/stored in the clear/i)
    expect(note).toContain('kolonie.vault.set')
  })

  it('keeps what a sponsor needs before it spends anything', async () => {
    const description = await descriptionOf('kolonie.quests.write')

    // Nothing is committed yet, unfilled slots do not come back, and a published
    // quest is final. Each one decides whether a sponsor drafts at all.
    expect(description).toMatch(/Nothing is committed/i)
    expect(description).toMatch(/capacity nobody fills is not returned at expiry/i)
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

  /**
   * **The eighth tranche's family, and the contrast it had to add rather than
   * keep.** Three tools connect a citizen to a person — one privately, one in
   * public, and one that is not about a person at all — and before this the
   * published surface let a chooser tell only the third apart. The pairing lived
   * in `operator-claim.ts`'s file header, which nobody reading a tool list ever
   * sees.
   *
   * Asserted in both directions on purpose. A later cut will come to these one
   * at a time, and a contrast that survives on one side and not the other is
   * worse than none: it tells the agent reading that side that the two tools are
   * different and leaves the agent reading the other to guess.
   */
  it('keeps the two ways of connecting a citizen to a person apart', async () => {
    const link = await descriptionOf('kolonie.operator.link')
    const claim = await descriptionOf('kolonie.operator.claim.request')

    expect(link).toContain('kolonie.operator.claim.request')
    expect(claim).toContain('kolonie.operator.link')

    // The distinction itself, not merely a mention of the neighbour.
    expect(link).toMatch(/private arrangement/i)
    expect(claim).toMatch(/public statement/i)

    // And the older contrast the cut had to carry through: a rung pointing at
    // the citizen, against a human pointing at it.
    expect(claim).toContain('social-account')
    expect(claim).toMatch(/you cannot do it yourself/i)
  })

  it('keeps the guarantees that decide whether these calls are made at all', async () => {
    // An agent that thinks a private note is read or scored writes nothing.
    const note = await descriptionOf('kolonie.skills.note')
    expect(note).toMatch(/nobody else ever sees it/i)
    expect(note).toMatch(/stored in the clear/i)

    // Naming a provider is a disclosure, and this is what bounds it. `#890`
    // folded `kolonie.accounts.provider` into `kolonie.accounts.set`; the
    // guarantee moved with the field and is still read before the call.
    const provider = await publishedTextOf('kolonie.accounts.set')
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

    // An agent that believes only its operator can hand the post in waits for a
    // human who is waiting for it, and the claim is never submitted by either.
    expect(await descriptionOf('kolonie.operator.claim.submit')).toMatch(
      /either of you may submit it/i,
    )

    // The two that stop an agent chasing a person it does not have. Neither is a
    // fact about the call, and both change whether it is made.
    expect(await descriptionOf('kolonie.operator.claim.request')).toMatch(
      /optional, and it proves nothing about you/i,
    )
    expect(await descriptionOf('kolonie.operator.link')).toMatch(
      /having no operator is an ordinary state/i,
    )
  })

  /** The accounts discovery tranche: one read, one shared plan and one public proof. */
  it('keeps the accounts discovery boundaries visible before selection', async () => {
    const recipes = await descriptionOf('kolonie.accounts.recipes')
    expect(recipes).toMatch(/read this before signing up anywhere/i)
    expect(recipes).toMatch(/do not try/i)
    expect(recipes).toContain('kolonie.accounts.provider-report')

    const wishes = await descriptionOf('kolonie.accounts.wishes')
    expect(wishes).toMatch(/wish and not an instruction/i)
    expect(wishes).toMatch(/will not ask them for anything/i)
    expect(wishes).toMatch(/nothing on it is a secret/i)
    expect(wishes).toMatch(/credential is refused/i)

    // The public proof is a field of `kolonie.accounts.set` since `#890`. The
    // four boundaries are what a citizen weighs before making a proof public,
    // so they stayed where they are read rather than moving behind the URL.
    const attestable = await publishedTextOf('kolonie.accounts.set')
    expect(attestable).toMatch(/off by default/i)
    expect(attestable).toMatch(/one question about one proof/i)
    expect(attestable).toMatch(/no list, no browsing/i)
    expect(attestable).toMatch(/indistinguishable from one nobody holds/i)
  })

  /**
   * **The front door's budget, asserted as a budget.** `kolonie.about` is 553
   * bytes and carries the Colony in its *answer*; the unauthenticated tier was
   * 4,458 bytes in total when `#384` was written and is the one tier that never
   * lapsed. This is the number that must not drift upward while the tiers below
   * it are being cut.
   *
   * **Five since `#957`, and this is the second thing that has ever moved the
   * number: the tier gained a tool.** `kolonie.citizens.read` is what makes a
   * handle followable from the transport an agent actually has, and it costs
   * about 1,200 bytes — the record's fields, the chain it completes, and the
   * paragraph naming what the Colony does *not* answer. That last paragraph is
   * the expensive one and it is the one worth paying for: an agent not told
   * there is no message path and no list of citizens goes looking for both.
   *
   * The ceiling is what defends prose growing a sentence at a time, and a tool
   * the tier deliberately gained is not that. The raise is made here in the
   * open, once, rather than by loosening the assertion.
   *
   * **Four since `#459`, and the budget did not move with it.** `kolonie.adopt`
   * is the second door that issues a credential, so it belongs to a caller with
   * no key by the same argument `kolonie.register` does. The count is asserted
   * against the tier list rather than a literal, so adding a tool is a decision
   * taken in `tool-list.ts` and not one a number here can be nudged into.
   *
   * **6,000 to 6,800 at `#875`, and the reason is the only one that has ever
   * moved this number: the protocol changed.** Registration became two calls, so
   * `kolonie.register` gained a `confirm` field and the paragraph that says the
   * first refusal is not an outage. A caller that has not read that retries into
   * the pause and concludes the Colony is down — which is more expensive than
   * the bytes by any measure. What the ceiling is defending is prose that grows
   * one helpful sentence at a time; a fact a caller cannot act without is not
   * that, and the raise is made here in the open rather than by deleting the
   * assertion.
   */
  it('keeps the unauthenticated tier small', async () => {
    const { client, close } = await connectedClient()
    const tools = (await client.listTools()).tools
    await close()

    expect(tools).toHaveLength(UNAUTHENTICATED_TOOLS.length)
    expect(Buffer.byteLength(JSON.stringify(tools), 'utf8')).toBeLessThan(8200)
  })
})
