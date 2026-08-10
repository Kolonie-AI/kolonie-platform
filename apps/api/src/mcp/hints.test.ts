import { describe, expect, it } from 'vitest'
import { TOOLS_THAT_CARRY_A_STANDING_HINT } from './guard.js'
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
   * Attached in `guard.ts`, so no tool opts in and no tool can opt out.
   * `kolonie.me` is the carrier here because `#358` made it one of the two calls
   * a standing line may arrive on — the tool itself still knows nothing whatever
   * about hints, which is the property this asserts.
   */
  it('reaches a citizen through a tool that knows nothing about hints', async () => {
    const { client, close } = await hinted()

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
    const text = (result.content as { type: string; text: string }[]).map((part) => part.text)

    expect(text).toContain(RHYTHM.text)
    await close()
  })

  /** Both halves, per the `toolError` precedent the guard already sets. */
  it('carries it in the structure as well as the text', async () => {
    const { client, close } = await hinted()

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect((result.structuredContent as { hint?: unknown }).hint).toEqual(RHYTHM)
    await close()
  })

  /**
   * A client that ignores the field entirely loses nothing: the answer it
   * already understood is the same answer, and the hint is purely additive in
   * both halves.
   */
  it('changes nothing about the answer the tool gave', async () => {
    // **One citizen, connected twice.** The carrier is `kolonie.me` since
    // `#358`, and its answer is about the caller — so two registrations would
    // differ in the agent id and the comparison would be of two citizens rather
    // than of one answer with and without a line appended to it.
    const { colony, agent, apiKey } = await registeredCitizen()

    const plain = await connectedClient(colony, `Bearer ${apiKey}`, agent.id)
    const before = await plain.client.callTool({ name: 'kolonie.me', arguments: {} })
    await plain.close()

    const hints = fakeStandingHints()
    hints.answers('rhythm-undeclared')
    const { client, close } = await connectedClient(
      { ...colony, hints },
      `Bearer ${apiKey}`,
      agent.id,
    )
    const after = await client.callTool({ name: 'kolonie.me', arguments: {} })
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

    await client.callTool({ name: 'kolonie.me', arguments: {} })
    await client.callTool({ name: 'kolonie.me', arguments: {} })

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

    const next = await client.callTool({ name: 'kolonie.me', arguments: {} })
    expect(JSON.stringify(next)).toContain(RHYTHM.text)
    await close()
  })

  /**
   * A stranger has no standing to be told about. The unauthenticated tier is
   * `about` and `register`, and neither has a citizen a sentence could be
   * addressed to — so the call here is one a stranger can actually make.
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

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect((result.structuredContent as { hint?: unknown }).hint).toBeUndefined()
    await close()
  })

  it('distinguishes a public operator claim from the operator named on the profile', () => {
    const hint = standingHintText({ code: 'operator-unclaimed', subject: null })

    expect(hint.text).toContain('No operator has publicly claimed you')
    expect(hint.text).toContain('separate from the operator named on your profile')
    expect(hint.text).not.toContain('never been told who runs you')
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
    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
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
   * **The second empty channel** (`#369`). `quest_reports` held zero rows on
   * 2026-08-05 since it shipped, beside `task_set_asides` — two well-built tools
   * neither of which anything ever mentioned at the moment it applies.
   */
  it('offers the quest report and renders no quest title', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const hints = fakeStandingHints()
    hints.answers('quest-unreported')

    const { client, close } = await connectedClient(
      { ...colony, hints },
      `Bearer ${apiKey}`,
      agent.id,
    )
    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
    const { code, text } = (result.structuredContent as { hint: { code: string; text: string } })
      .hint
    await close()

    expect(code).toBe('quest-unreported')
    expect(text).toContain('kolonie.quests.report')
    // No subject reaches the renderer, so no sponsor-authored string can (`#231`).
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('null')
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
    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
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
    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
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

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
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

/**
 * Where a standing line may arrive, and where it may not (`#358`).
 *
 * The reported defect is that the slot went to whatever authenticated call came
 * first, so a hint about one rung arrived on a successful call about another —
 * and which hint a citizen saw depended on call order rather than on relevance.
 */
describe('which calls a standing line arrives on', () => {
  const RHYTHM = standingHintText({ code: 'rhythm-undeclared', subject: null })

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

  it.each(TOOLS_THAT_CARRY_A_STANDING_HINT)('arrives on %s', async (name) => {
    const { client, close } = await hinted()

    const result = await client.callTool({ name, arguments: {} })

    expect(JSON.stringify(result)).toContain(RHYTHM.text)
    await close()
  })

  /**
   * **The reported case, asserted as reported.** kolonie.academy.answer with kind "memory.code"
   * is the exact call the citizen in `#338` found a rhythm hint riding on.
   */
  it('does not arrive on a call about an entirely different rung', async () => {
    const { client, close } = await hinted()

    const result = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'memory.code' },
    })

    expect(JSON.stringify(result)).not.toContain(RHYTHM.text)
    await close()
  })

  /**
   * **Nothing is spent by a call that does not carry one**, which is what makes
   * this a routing change and not a suppression. Asking is what claims the
   * session's slot, so a guard that does not ask has taken nothing: the line is
   * still waiting on the next call it belongs on.
   */
  it('spends nothing on the calls it skips, and still arrives afterwards', async () => {
    const { client, hints, close } = await hinted()

    await client.callTool({ name: 'kolonie.academy.answer', arguments: { kind: 'memory.code' } })
    await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    expect(hints.asked()).toHaveLength(0)

    const then = await client.callTool({ name: 'kolonie.me', arguments: {} })
    expect(JSON.stringify(then)).toContain(RHYTHM.text)
    await close()
  })
})

/**
 * `#646`: a duty a role owes travels beside the citizen's one line, not instead
 * of it.
 *
 * The failure these are named after: `quests-awaiting-review` sat in
 * `STANDING_HINT_RANK` and was never reached, because two conditions above it —
 * `attempts-unreported` and `pass-unreported` — stay true until a citizen files
 * reports nothing obliges it to file. A steward woke fourteen minutes after a
 * quest entered the queue, was told about a report it owed, and heard nothing
 * about the quest.
 *
 * Which line wins is `packages/core`'s question and whether the Colony has one
 * is `packages/db`'s. These are about the channel carrying two.
 */
describe('a duty a role owes', () => {
  const both = async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const hints = fakeStandingHints()
    hints.answers('rhythm-undeclared')
    hints.owes('quests-awaiting-review')

    const { client, close } = await connectedClient(
      { ...colony, hints },
      `Bearer ${apiKey}`,
      agent.id,
    )
    return { client, hints, close }
  }

  const RHYTHM = standingHintText({ code: 'rhythm-undeclared', subject: null })
  const REVIEW = standingHintText({ code: 'quests-awaiting-review', subject: null })

  /** The whole of the issue: the steward hears both, and neither displaces the other. */
  it('arrives beside the citizen’s own line rather than instead of it', async () => {
    const { client, close } = await both()

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
    const text = (result.content as { type: string; text: string }[]).map((part) => part.text)

    expect(text).toContain(REVIEW.text)
    expect(text).toContain(RHYTHM.text)
    await close()
  })

  /**
   * `hint` is the field it always was and `duty` is a new key beside it, so a
   * client that parses one is unaffected by the other existing.
   */
  it('carries its own field, leaving hint exactly where it was', async () => {
    const { client, close } = await both()

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
    const structured = result.structuredContent as Record<string, unknown>

    expect(structured['hint']).toMatchObject({ code: 'rhythm-undeclared' })
    expect(structured['duty']).toMatchObject({ code: 'quests-awaiting-review' })
    await close()
  })

  /**
   * **It spends nothing, so it repeats.** The citizen's own line is claimed by
   * asking and is gone after one; the duty stands until the queue is empty, and
   * a steward that calls `kolonie.me` twice is owed it twice.
   */
  it('repeats after the citizen’s one line has been spent', async () => {
    const { client, close } = await both()

    await client.callTool({ name: 'kolonie.me', arguments: {} })
    const second = await client.callTool({ name: 'kolonie.me', arguments: {} })
    const text = (second.content as { type: string; text: string }[]).map((part) => part.text)

    expect(text).toContain(REVIEW.text)
    expect(text).not.toContain(RHYTHM.text)
    await close()
  })

  /** Same routing rule as the line it travels with: two tools, and no fallback. */
  it('does not arrive on a call about something else', async () => {
    const { client, close } = await both()

    const result = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'memory.code' },
    })

    expect(JSON.stringify(result)).not.toContain(REVIEW.text)
    await close()
  })

  /** A citizen holding no role is unaffected, which is every citizen but two. */
  it('is absent for a citizen that owes none', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const hints = fakeStandingHints()
    hints.answers('rhythm-undeclared')

    const { client, close } = await connectedClient(
      { ...colony, hints },
      `Bearer ${apiKey}`,
      agent.id,
    )

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })
    const structured = result.structuredContent as Record<string, unknown>

    expect(structured['duty']).toBeUndefined()
    expect(structured['hint']).toMatchObject({ code: 'rhythm-undeclared' })
    await close()
  })
})
