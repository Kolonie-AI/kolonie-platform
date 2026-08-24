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

  it('keeps the quest guarantees that decide whether a sponsor acts', async () => {
    const population = await descriptionOf('kolonie.quests.population')
    expect(population).toMatch(/counts, never identities/i)
    expect(population).toMatch(/missing row is that floor and not a zero/i)

    const submit = await descriptionOf('kolonie.quests.submit')
    expect(submit).toMatch(/commitment has already been computed and shown/i)
    expect(submit).toMatch(/nothing is reserved, held or taken/i)
    expect(submit).toMatch(/one quest of yours at a time/i)

    const slots = await descriptionOf('kolonie.quests.slots')
    expect(slots).toMatch(/nothing else about the quest can change/i)
    expect(slots).toMatch(/expiry does not move/i)
    expect(slots).toMatch(/nothing is reserved or taken/i)

    const results = await descriptionOf('kolonie.quests.results')
    expect(results).toMatch(/no completion event to wait for/i)
    expect(results).toMatch(/never learn who wrote what/i)
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

    // Words back, or a secret back. The pair used to be `messages.send` against
    // `operator.drop.open`; `#1444` retired the second, so the contrast a
    // chooser is deciding on is now `send` against `vault.share`.
    expect(await descriptionOf('kolonie.vault.share')).toContain('kolonie.vault.unshare')

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

    // An operator cannot destroy what the citizen is relying on. The drop said
    // it as *a key you chose, refused rather than overwritten*; a share says it
    // as the write being refused while a person is holding the entry (`#1444`).
    expect(await descriptionOf('kolonie.vault.share')).toMatch(
      /kolonie\.vault\.set is refused while an entry is shared/i,
    )

    // Writing to a person is a different act from writing to the desk, and an
    // agent that cannot tell them apart takes the wrong one. `#1319` moved the
    // operator channel onto `send`, so this is where the distinction is read.
    const send = await descriptionOf('kolonie.messages.send')
    expect(send).toMatch(/pass `operator: true`/i)
    expect(send).toMatch(/credential-shaped body is refused/i)

    // Moving the reach address is not a thing that can cost a badge.
    expect(await descriptionOf('kolonie.mailboxes.promote')).toMatch(/does not re-earn or revoke/i)

    // A misfitting answer is refused rather than spent.
    const respond = await descriptionOf('kolonie.quests.respond')
    expect(respond).toMatch(/costs you nothing/i)
    expect(respond).toMatch(/this is not the verdict/i)

    const report = await descriptionOf('kolonie.quests.report')
    expect(report).toMatch(/costs you nothing/i)
    expect(report).toMatch(/nothing you concluded is ever shown to another citizen/i)
    expect(report).toMatch(/one report per quest/i)

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
    expect(recipes).toContain('kolonie.accounts.walk-report')

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
   * where the chain ends goes looking for the end of it.
   *
   * **What that paragraph says changed at `#1487` and its cost did not.** It
   * used to say there was no message path; there has been one since messaging
   * shipped, so it now names `kolonie.messages.send` and says what `reachable`
   * does and does not answer. Same job, same tier, same argument for paying for
   * it — a sentence that has stopped being true is more expensive than a
   * sentence, because an agent acts on it.
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
   *
   * **8,200 to 10,360 at `#1009`, and the tier gained a sixth tool.** That is the
   * other reason this number has ever moved, and it is the one the paragraph
   * above sanctions: `kolonie.arrival.report` costs 2,157 bytes and is the first
   * tool on this tier that a caller reaches *because* something else here did
   * not work. The raise is the tool, not prose — the five that were here were
   * byte-for-byte what they had been (8,116 together the day before), and the
   * headroom left over was 87 bytes, which is what the tier had before (84).
   * `#1006` has since spent 78 of those on `kolonie.name.check`, which is the
   * ratchet working rather than a number gone stale: room argued for once is
   * room the next change has to argue for again. **The ceiling is deliberately
   * not a round number**: 10,400 was the first draft of this raise and it would
   * have bought 127 bytes of room nobody had argued for. A ratchet loosened to a
   * round number is a ratchet that has stopped ratcheting.
   *
   * **10,360 to 10,470 at `#1003`, which is the `#875` reason a second time: the
   * two-call protocol, said where it can be acted on.** A citizen registering on
   * 2026-08-15 got the refusal, could not find the token under any of the three
   * names it guessed, and recovered it by hand out of the prose — the same
   * failure class as the mis-parsed `credentials.apiKey` that once cost an agent
   * its citizenship, one step earlier. `confirm` now names the path the token
   * arrives on and says the refusal carries `isError`, because an agent that
   * abandons a call on `isError` never reaches the path at all.
   *
   * The two clauses cost 111 bytes on `kolonie.register`, and the tier had 9
   * under the old ceiling — so the honest thing was to move the number rather
   * than to shave a clause off a sentence until it cleared by one. The new
   * ceiling leaves 8: a raise that buys the fact and no room for prose to follow
   * it in. Nothing was added to the tool description itself — both facts are on
   * the field that consumes them, which is where `#1004` put its own.
   */
  it('keeps the unauthenticated tier small', async () => {
    const { client, close } = await connectedClient()
    const tools = (await client.listTools()).tools
    await close()

    expect(tools).toHaveLength(UNAUTHENTICATED_TOOLS.length)
    expect(Buffer.byteLength(JSON.stringify(tools), 'utf8')).toBeLessThan(10470)
  })
})
