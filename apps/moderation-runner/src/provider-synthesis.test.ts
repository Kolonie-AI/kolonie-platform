import { describe, expect, it, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { BRIEFING_CLAIM_MAX_LENGTH, ProviderBriefingClaimSchema } from '@kolonie-ai/core'
import type { ProviderBriefingSource } from '@kolonie-ai/db'
import { PROVIDER_SYNTHESIS_PROMPT, synthesiseProvider } from './provider-synthesis.js'
import { fakeModel, type FakeModel } from './__fixtures__/model.js'

let model: FakeModel

beforeEach(() => {
  model = fakeModel()
})

/**
 * One walk as the synthesis receives it.
 *
 * Every value invented, on `synthesis.test.ts`' terms: mailboxes are on
 * `example.invalid`, which RFC 2606 reserves so nothing resolves, and hosts are
 * literals from RFC 5737's documentation range.
 */
const aWalk = (overrides: Partial<ProviderBriefingSource> = {}): ProviderBriefingSource => ({
  id: randomUUID(),
  // The ordinary case: an agent that stopped somewhere. `proved` and `refused`
  // are set where the point is what the outcome does to the prompt.
  outcome: 'abandoned',
  content: 'The signup form asked for a phone number on the last step.',
  platform: 'openclaw',
  finishedAt: new Date().toISOString(),
  ...overrides,
})

const atProvider = (corpus: readonly ProviderBriefingSource[]) => ({
  provider: { kind: 'mailbox', provider: 'somewhere.example' },
  corpus,
})

describe('writing a provider briefing', () => {
  it('asks nothing of the model when nobody has walked the provider', async () => {
    const { claims } = await synthesiseProvider(atProvider([]), model)

    expect(claims).toEqual([])
    expect(model.calls()).toHaveLength(0)
  })

  /**
   * The division that makes a claim's count trustworthy, and it is the task
   * side's: the model writes prose and groups, the code does the arithmetic. What
   * differs here is what is being counted — a walk is one agent walking once, so
   * this is a tally of walks rather than a sum of pre-tallied confirmations.
   */
  it('counts the walks behind a claim rather than believing the model', async () => {
    const first = aWalk({ platform: 'openclaw' })
    const second = aWalk({ platform: 'openclaw' })
    const third = aWalk({ platform: 'claude' })
    model.composes({
      section: 'wall',
      text: 'Signup asks for a phone number on the last step.',
      sources: [first.id, second.id, third.id],
    })

    const { claims } = await synthesiseProvider(atProvider([first, second, third]), model)

    expect(claims[0]?.walks).toBe(3)
    expect(claims[0]?.platforms).toEqual({ openclaw: 2, claude: 1 })
  })

  /**
   * A walk named twice is one walk. The task side gets this for free because its
   * entries are already aggregates; here a model that cited the same id twice
   * would double a number that claims to count agents.
   */
  it('counts a walk once however often the model names it', async () => {
    const walk = aWalk()
    model.composes({ section: 'wall', text: 'A wall.', sources: [walk.id, walk.id] })

    const { claims } = await synthesiseProvider(atProvider([walk]), model)

    expect(claims[0]?.walks).toBe(1)
    expect(claims[0]?.sources).toEqual([walk.id])
    expect(claims[0]?.platforms).toEqual({ openclaw: 1 })
  })

  /**
   * `lastSupportedAt` answers *does this still describe the provider*, so it is
   * the newest walk behind a claim and not the oldest — and it is what the
   * currency rule then measures. A wall first met in March and met again last
   * week is a live wall.
   */
  it('dates a claim by its newest supporting walk', async () => {
    const old = aWalk({ finishedAt: '2026-03-01T00:00:00.000Z' })
    const recent = aWalk({ finishedAt: '2026-07-29T00:00:00.000Z' })
    model.composes({ section: 'wall', text: 'A wall.', sources: [old.id, recent.id] })

    const { claims } = await synthesiseProvider(atProvider([old, recent]), model)

    expect(claims[0]?.lastSupportedAt).toBe('2026-07-29T00:00:00.000Z')
  })

  /**
   * The corpus is closed in the schema handed to the provider, so this is the
   * second of two defences — and the one that still holds if a provider relaxes
   * strict schemas. A claim attributed to a walk nobody took would make the count
   * describe a corpus that does not exist.
   */
  it('drops a claim that cites a walk the corpus does not contain', async () => {
    const real = aWalk()
    model.composes(
      { section: 'wall', text: 'A real wall.', sources: [real.id] },
      { section: 'wall', text: 'An invented one.', sources: [randomUUID()] },
    )

    const { claims } = await synthesiseProvider(atProvider([real]), model)

    expect(claims.map((claim) => claim.text)).toEqual(['A real wall.'])
  })

  /**
   * **What was dropped is counted, so an empty briefing can be diagnosed**
   * (`#374`).
   *
   * An empty `claims` array has two causes that look identical from outside: the
   * model answered with nothing, or it answered and everything was dropped here.
   * They need opposite fixes — a prompt to rewrite, or a schema and a provider to
   * look at — and on the task side telling them apart cost a production round
   * trip because this number did not exist. It exists here from the first day.
   */
  it('counts what it dropped, and why, when nothing survives', async () => {
    const real = aWalk()
    model.composes(
      { section: 'wall', text: 'Cites nobody in the corpus.', sources: [randomUUID()] },
      { section: 'wall', text: '   ', sources: [real.id] },
      { section: 'wall', text: 'x'.repeat(BRIEFING_CLAIM_MAX_LENGTH + 1), sources: [real.id] },
    )

    const outcome = await synthesiseProvider(atProvider([real]), model)

    expect(outcome.claims).toEqual([])
    expect(outcome.proposed).toBe(3)
    expect(outcome.unsourced).toBe(1)
    expect(outcome.blank).toBe(1)
    expect(outcome.overlong).toBe(1)
  })

  /** The other cause, told apart from the one above by `proposed`. */
  it('reports nothing proposed when the model answered with nothing', async () => {
    const outcome = await synthesiseProvider(atProvider([aWalk()]), model)

    expect(outcome.claims).toEqual([])
    expect(outcome.proposed).toBe(0)
    expect(outcome.unsourced).toBe(0)
    expect(outcome.blank).toBe(0)
    expect(outcome.overlong).toBe(0)
  })

  /**
   * Exactly at the bound is inside it — the boundary a `>` and a `>=` disagree
   * about, and the schema this has to agree with uses `.max()`. What is kept has
   * to be servable, which is the property that failed on the task side (`#729`)
   * and made one rung's briefing throw for every citizen.
   */
  it('keeps a claim of exactly the maximum length, and keeps it servable', async () => {
    const walk = aWalk()
    model.composes({
      section: 'wall',
      text: 'y'.repeat(BRIEFING_CLAIM_MAX_LENGTH),
      sources: [walk.id],
    })

    const outcome = await synthesiseProvider(atProvider([walk]), model)

    expect(outcome.overlong).toBe(0)
    expect(ProviderBriefingClaimSchema.safeParse(outcome.claims[0]).success).toBe(true)
  })
})

/**
 * What reaches the model, and it is where this file earns its existence.
 *
 * The fake answers what a *correct* model would answer, so what is under test is
 * the pipeline around it — that a correct answer survives intact, and that the
 * corpus arrives in a form which makes the correct answer available at all. The
 * prompt's own wording is asserted below.
 */
describe('what the corpus tells the model', () => {
  /**
   * **The one error nobody downstream can catch.** *One agent gave up* published
   * as *this provider does not accept agents* is a statement about a real company
   * that no walk supports, read by every citizen choosing a provider afterwards.
   * It is said twice on purpose — in each walk's outcome line and again in the
   * prompt — so this asserts the half that travels with the evidence.
   */
  it('says in words that an agent which gave up was not necessarily turned away', async () => {
    const gaveUp = aWalk({ outcome: 'abandoned' })
    model.composes({ section: 'wall', text: 'A wall.', sources: [gaveUp.id] })

    await synthesiseProvider(atProvider([gaveUp]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('GAVE UP')
    expect(sent).toContain('did NOT necessarily refuse')
    // And it is not labelled as the one outcome that is evidence of a refusal.
    expect(sent).not.toContain('TURNED AWAY')
  })

  it('marks a refusal as the only outcome that is evidence the provider refused', async () => {
    const refused = aWalk({ outcome: 'refused' })
    model.composes({ section: 'wall', text: 'A wall.', sources: [refused.id] })

    await synthesiseProvider(atProvider([refused]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('TURNED AWAY')
    expect(sent).not.toContain('GAVE UP')
  })

  it('marks a walk that got the account, so its advice reads as a route', async () => {
    const proved = aWalk({ outcome: 'proved', content: 'The confirmation mail arrived at once.' })
    model.composes({ section: 'route', text: 'A route.', sources: [proved.id] })

    await synthesiseProvider(atProvider([proved]), model)

    expect(model.lastCall()?.user ?? '').toContain('GOT THE ACCOUNT')
  })

  /**
   * **The date is the provider side's substitute for authoritative text.** A task
   * briefing is handed the task's current instructions, which overrule the corpus
   * however many agents disagree. Nobody can hand this one the current state of a
   * third-party signup form, so what it gets instead is when each walk happened.
   */
  it('gives the model when each walk finished, and which provider this is about', async () => {
    const walk = aWalk({ finishedAt: '2026-03-01T00:00:00.000Z' })
    model.composes({ section: 'wall', text: 'A wall.', sources: [walk.id] })

    await synthesiseProvider(atProvider([walk]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('finished: 2026-03-01')
    expect(sent).toContain('somewhere.example')
    expect(sent).toContain('a mailbox account')
  })
})

/**
 * The prompt is the deliverable, the same way `SYNTHESIS_PROMPT` is, so the
 * instructions that carry the design are asserted rather than trusted to survive
 * an edit. The three below are what make this a second prompt rather than a
 * parameter on the first.
 */
describe('what the provider synthesis prompt says', () => {
  it('forbids quoting, and names what must never be written', () => {
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('WRITE, DO NOT QUOTE')
    for (const forbidden of ['mailbox address', 'hostname', 'operator name', 'wallet address']) {
      expect(PROVIDER_SYNTHESIS_PROMPT).toContain(forbidden)
    }
    // Including the one a walk carries that a report does not: the account the
    // walker registered at this very provider.
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('the agent registered AT this provider')
  })

  it('says the subject is a real company that never agreed to be written about', () => {
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('YOU ARE WRITING ABOUT SOMEBODY ELSE')
    // The line the rule is for: a finding is what agents met, an accusation is
    // what somebody supposes the company meant by it.
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('is an accusation')
  })

  it('forbids calling a provider hostile on the strength of walks that gave up', () => {
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain(
      'AN AGENT THAT GAVE UP WAS NOT NECESSARILY TURNED AWAY',
    )
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('rejects, blocks or bans agents')
    // And why, so it is not trimmed as repetition of the outcome line.
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('most damaging thing you could get wrong')
  })

  /**
   * The provider corpus decays in a way a task corpus does not, and this is the
   * instruction that stands in for the authoritative text there is none of.
   */
  it('tells the model to say when a finding was met rather than assert it stands', () => {
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('SAY WHEN, NOT WHETHER')
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('may be gone')
  })

  /** Advice from a walk that stopped is still advice — the task side's `#85` seam. */
  it('tells the model to read advice out of a walk that gave up', () => {
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('ADVICE FROM A WALK THAT GAVE UP IS STILL ADVICE')
  })

  it('draws the same line between a provider wall and a runtime fault that dedup draws', () => {
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('ONE CLAIM PER UNDERLYING PROBLEM')
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('cannot be cleared headless')
  })

  /** Counts are the Colony's to attach. A model that wrote them would invent one. */
  it('tells the model not to write counts', () => {
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('DO NOT write counts')
  })

  /**
   * Both halves of the correction the task prompt needed in production (`#374`):
   * an empty section gets no claim, and that is not licence to write nothing. The
   * first instruction alone produced a briefing saying the Colony found nothing
   * on a rung somebody had written usable advice for.
   */
  it('tells the model to omit an empty section without writing fewer claims', () => {
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('A SECTION WITH NOTHING IN IT GETS NO CLAIM')
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('presents an absence as evidence')
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('THIS IS NOT A LICENCE TO WRITE FEWER CLAIMS')
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('AN EMPTY LIST OF CLAIMS IS ALMOST ALWAYS WRONG')
  })

  /**
   * The section that is worth the most to a reader: *nothing here gets past
   * this*, which is how an agent finds out a provider is not worth the hour
   * before it spends the hour.
   */
  it('reserves the unsolved section for walls no walk got past', () => {
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('Use "unsolved" only when')
    expect(PROVIDER_SYNTHESIS_PROMPT).toContain('before it spends the hour')
  })
})
