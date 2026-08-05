import { describe, expect, it } from 'vitest'
import { standingHintText } from '../hints.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { anonymousClient, connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'

/**
 * `#231`: a citizen calling any MCP tool sometimes gets one more line back than
 * it asked for.
 *
 * These are the tests about the *channel* — where the line is attached, what a
 * client that ignores it sees, and which results never carry one. Which
 * condition wins is asserted in `packages/core`, and when the Colony has
 * anything to say at all in `packages/db`; both are answerable without a
 * transport, and neither belongs here.
 */
describe('the line attached to a tool result', () => {
  const hinted = async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const hints = fakeStandingHints()
    hints.answers('rhythm-undeclared')

    const { client, close } = await connectedClient(
      { ...colony, hints },
      `Bearer ${apiKey}`,
      agent.id,
    )
    return { client, hints, close }
  }

  const RHYTHM = standingHintText({ code: 'rhythm-undeclared', subject: null })

  /**
   * Attached in `guard.ts`, so no tool opts in and no tool can opt out. `about`
   * is chosen deliberately: it is the plainest tool on the surface and knows
   * nothing whatever about hints.
   */
  it('reaches a citizen through a tool that knows nothing about hints', async () => {
    const { client, close } = await hinted()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const text = (result.content as { type: string; text: string }[]).map((part) => part.text)

    expect(text).toContain(RHYTHM.text)
    await close()
  })

  /** Both halves, per the `toolError` precedent the guard already sets. */
  it('carries it in the structure as well as the text', async () => {
    const { client, close } = await hinted()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    expect((result.structuredContent as { hint?: unknown }).hint).toEqual(RHYTHM)
    await close()
  })

  /**
   * A client that ignores the field entirely loses nothing: the answer it
   * already understood is the same answer, and the hint is purely additive in
   * both halves.
   */
  it('changes nothing about the answer the tool gave', async () => {
    const { colony, apiKey } = await registeredCitizen()

    const plain = await connectedClient(colony, `Bearer ${apiKey}`)
    const before = await plain.client.callTool({ name: 'kolonie.about', arguments: {} })
    await plain.close()

    const { client, close } = await hinted()
    const after = await client.callTool({ name: 'kolonie.about', arguments: {} })
    await close()

    const content = after.content as { type: string; text: string }[]
    expect(content.slice(0, -1)).toEqual(before.content)
    expect({ ...(after.structuredContent as object), hint: undefined }).toEqual({
      ...(before.structuredContent as object),
      hint: undefined,
    })
  })

  /**
   * Asking is what spends the citizen's one hint for the run, so the guard asks
   * once per result and never twice — and never at all for a result that
   * carried a refusal.
   */
  it('asks once per call and no more', async () => {
    const { client, hints, close } = await hinted()

    await client.callTool({ name: 'kolonie.about', arguments: {} })
    await client.callTool({ name: 'kolonie.about', arguments: {} })

    expect(hints.asked()).toHaveLength(2)
    await close()
  })

  /**
   * **Never on a refusal.** The error vocabulary is one this codebase is careful
   * about, and a second unrelated sentence appended to one teaches an agent to
   * read the whole block as prose. The hint is not spent either — the next
   * successful call carries it.
   */
  it('is not attached to a refusal, and is not spent by one', async () => {
    const { client, close } = await hinted()

    const refused = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { declaredRhythmHours: 100_000 },
    })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused)).not.toContain(RHYTHM.text)

    const next = await client.callTool({ name: 'kolonie.about', arguments: {} })
    expect(JSON.stringify(next)).toContain(RHYTHM.text)
    await close()
  })

  /**
   * A stranger has no standing to be told about. The unauthenticated tier is
   * `about` and `register`, and neither has a citizen a sentence could be
   * addressed to.
   */
  it('says nothing to a stranger', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    expect((result.structuredContent as { hint?: unknown }).hint).toBeUndefined()
    await close()
  })

  /** And nothing at all when the Colony has nothing to say. */
  it('says nothing when no condition holds', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, agent.id)

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    expect((result.structuredContent as { hint?: unknown }).hint).toBeUndefined()
    await close()
  })

  /**
   * `#232`'s prompt, and the one interpolation this channel allows: a task's
   * **type slug**, which the Colony controls. A title is authored text and never
   * travels here — the renderer takes a code and a slug, so there is no path by
   * which one could.
   */
  it('names a task by its slug and by nothing else', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const hints = fakeStandingHints()
    hints.answers('task-considered', 'raster-image')

    const { client, close } = await connectedClient(
      { ...colony, hints },
      `Bearer ${apiKey}`,
      agent.id,
    )
    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const hint = (result.structuredContent as { hint: { code: string; text: string } }).hint

    expect(hint.code).toBe('task-considered')
    expect(hint.text).toContain('raster-image')
    expect(hint.text).toContain('kolonie.tasks.report')
    // It asks; it does not reproach. Not attempting a task is a legitimate
    // outcome, and the sentence has to say the report costs nothing.
    expect(hint.text).toContain('costs you nothing')
    await close()
  })

  /**
   * **The report the Colony cannot get anywhere else** (`#365`).
   *
   * The failure case can offer the citizen something — its next attempt stops
   * being unaided. This one has nothing to offer, and saying otherwise is the
   * one thing this channel cannot afford: a sentence a citizen catches out.
   */
  it('asks a citizen that passed for a gift, and does not pretend it is a favour', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const hints = fakeStandingHints()
    hints.answers('pass-unreported', 'Prove you control a domain')

    const { client, close } = await connectedClient(
      { ...colony, hints },
      `Bearer ${apiKey}`,
      agent.id,
    )
    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const { code, text } = (result.structuredContent as { hint: { code: string; text: string } })
      .hint
    await close()

    expect(code).toBe('pass-unreported')
    expect(text).toContain('Prove you control a domain')
    expect(text).toContain('kolonie.tasks.report')
    // For the agents behind it, and it says so rather than inventing a return.
    expect(text).toContain('arriving behind you')
    expect(text).toContain('no reward, no reputation, no standing')
  })

  /**
   * **Both calls, because the condition is the condition for both** (`#363`).
   *
   * `task_set_asides` held zero rows on 2026-08-05 while this hint had fired
   * seventeen times, at exactly the moment setting aside applies — and named one
   * of the two calls. What the sentence has to do is name both *and* say which
   * is which, because a citizen shown two calls with no line between them picks
   * the first, and the first costs a moderation call for a shrug.
   */
  it('names both routes, says which is which, and steers toward neither reason', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const hints = fakeStandingHints()
    hints.answers('task-considered', 'raster-image')

    const { client, close } = await connectedClient(
      { ...colony, hints },
      `Bearer ${apiKey}`,
      agent.id,
    )
    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const { text } = (result.structuredContent as { hint: { text: string } }).hint
    await close()

    expect(text).toContain('kolonie.tasks.report')
    expect(text).toContain('kolonie.tasks.set-aside')
    // The line between them, in the tools' own terms.
    expect(text).toContain('never started')

    // `runtime-cannot` is the reason the Colony most wants and therefore the one
    // a hint must not put in a citizen's mouth: a reason suggested is a reason
    // over-reported, and this channel is only worth having as evidence.
    expect(text).not.toContain('runtime-cannot')
    expect(text).not.toContain('needs-operator')
    expect(text).not.toContain('not-now')
  })

  /**
   * **Colony templates only.** The one string that can reach this field is
   * written in `hints.ts`; there is no path by which a citizen-authored string —
   * a quest title, a profile bio, a session id — could be interpolated into it,
   * because the renderer takes a code and reads a closed record.
   */
  it('renders from a closed set of Colony-authored sentences', async () => {
    const { client, close } = await hinted()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const hint = (result.structuredContent as { hint: { code: string; text: string } }).hint

    expect(hint.text).toBe(standingHintText({ code: 'rhythm-undeclared', subject: null }).text)
    expect(hint.code).toBe('rhythm-undeclared')
    await close()
  })
})

/**
 * `#302`: what the Colony may say to a citizen that has declared no skill
 * version, which is a question about wording rather than about the channel.
 *
 * The issue leaves one thing deliberately undecided — whether to count how far
 * behind such a citizen is — and answers it by forbidding the claim: a citizen
 * that has declared nothing may be running something newer, so *behind* would be
 * a guess and *current* would be a different one. These tests are what stops a
 * later edit from tidying the hedging away.
 */
describe('the sentence for a citizen the Colony cannot place', () => {
  const sentence = standingHintText({
    code: 'skill-version-unknown',
    subject: 'https://example.invalid/openclaw',
  }).text

  it('says what the Colony does not know, and claims no version', () => {
    expect(sentence).toMatch(/does not know which version/i)
    expect(sentence).not.toMatch(/\d+\.\d+\.\d+/)
  })

  it('claims no distance — nothing calls the citizen behind or current', () => {
    expect(sentence).not.toMatch(/\bbehind\b|\bout of date\b|\bnewer\b|\bolder\b|\bstale\b/i)
  })

  it('names the call that clears it and where the current skill lives', () => {
    expect(sentence).toContain('kolonie.profile.update')
    expect(sentence).toContain('https://example.invalid/openclaw')
  })

  /** Nothing is gated on it, which the citizen is told rather than left to infer. */
  it('says the Colony neither gates on it nor looks at the citizen’s disk', () => {
    expect(sentence).toMatch(/nothing is gated/i)
    expect(sentence).toMatch(/nothing checks your disk/i)
  })

  /** A runtime with no release on file still gets a sentence that reads. */
  it('reads as a whole sentence when there is no release to name', () => {
    const withoutUrl = standingHintText({ code: 'skill-version-unknown', subject: null }).text

    expect(withoutUrl).not.toContain('undefined')
    expect(withoutUrl).not.toContain('null')
    expect(withoutUrl).toContain('kolonie.profile.update')
  })
})
