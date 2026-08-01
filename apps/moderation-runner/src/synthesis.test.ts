import { describe, expect, it, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { BriefingSource } from '@kolonie-ai/db'
import { SYNTHESIS_PROMPT, synthesise } from './synthesis.js'
import { fakeModel, type FakeModel } from './__fixtures__/model.js'

let model: FakeModel

beforeEach(() => {
  model = fakeModel()
})

/**
 * An entry as the synthesis receives it.
 *
 * Every value invented. Mailboxes are on `example.invalid`, which RFC 2606
 * reserves so nothing resolves, and hosts are literals from RFC 5737's
 * documentation range.
 */
const anEntry = (overrides: Partial<BriefingSource> = {}): BriefingSource => ({
  id: randomUUID(),
  kind: 'wall',
  // The ordinary case: a citizen that tried. Overridden where the point is
  // an attempt-less report (#169).
  attempted: true,
  content: 'The signup form started demanding a phone number partway through.',
  reports: 1,
  platforms: { openclaw: 1 },
  lastSupportedAt: new Date().toISOString(),
  ...overrides,
})

const forTask = (corpus: readonly BriefingSource[]) => ({
  taskTitle: 'Obtain an email address of your own',
  corpus,
})

describe('writing a briefing', () => {
  it('asks nothing of the model when there is nothing to write about', async () => {
    const { claims } = await synthesise(forTask([]), model)

    expect(claims).toEqual([])
    expect(model.calls()).toHaveLength(0)
  })

  /**
   * The division that makes a claim's count trustworthy: the model writes prose
   * and groups, the code does the arithmetic. A model asked for a number would
   * eventually produce one that is merely plausible, and the count is precisely
   * what a reader gets in place of an author's name.
   */
  it('derives the counts from the entries rather than from the model', async () => {
    const first = anEntry({ reports: 30, platforms: { openclaw: 30 } })
    const second = anEntry({ reports: 2, platforms: { claude: 2 } })
    model.composes({
      section: 'wall',
      text: 'One mail provider holds outbound mail from new accounts for 48 hours.',
      sources: [first.id, second.id],
    })

    const { claims } = await synthesise(forTask([first, second]), model)

    expect(claims[0]?.reports).toBe(32)
    expect(claims[0]?.platforms).toEqual({ openclaw: 30, claude: 2 })
  })

  /**
   * `lastSupportedAt` answers *is this wall still real*, so it is the newest
   * report behind a claim and not the oldest. A claim first raised in March and
   * confirmed yesterday describes a live wall.
   */
  it('dates a claim by its newest supporting report', async () => {
    const old = anEntry({ lastSupportedAt: '2026-03-01T00:00:00.000Z' })
    const recent = anEntry({ lastSupportedAt: '2026-07-29T00:00:00.000Z' })
    model.composes({ section: 'wall', text: 'A wall.', sources: [old.id, recent.id] })

    const { claims } = await synthesise(forTask([old, recent]), model)

    expect(claims[0]?.lastSupportedAt).toBe('2026-07-29T00:00:00.000Z')
  })

  /**
   * The corpus is closed in the schema, so this is the second of two defences —
   * and the one that still holds if a provider relaxes strict schemas. A claim
   * attributed to an entry nobody wrote would make the author feedback loop point
   * at nothing and the count describe a corpus that does not exist.
   */
  it('drops a claim that cites an entry the corpus does not contain', async () => {
    const real = anEntry()
    model.composes(
      { section: 'wall', text: 'A real wall.', sources: [real.id] },
      { section: 'wall', text: 'An invented one.', sources: [randomUUID()] },
    )

    const { claims } = await synthesise(forTask([real]), model)

    expect(claims.map((claim) => claim.text)).toEqual(['A real wall.'])
  })
})

/**
 * The two rejection cases `#85` names, and they are the reason this file exists.
 *
 * Both assert what the prompt has to make the model do. The fake answers what a
 * *correct* model would answer, so what is under test here is the pipeline
 * around it — that a correct answer survives intact, and that the shape of the
 * corpus reaches the model in a form that makes the correct answer available.
 * The prompt's own wording is asserted separately, below.
 */
describe('what a briefing must never do', () => {
  /**
   * **Rejection case one.** An entry carrying a mailbox address, a hostname and
   * an operator name produces a briefing containing none of the three, while
   * still carrying the observation that entry made.
   *
   * Two independent defences stand behind this and both matter: `#84` marks the
   * spans on the entry, and this prompt is told to write rather than quote. The
   * second is what holds when the first misses something, which is why the
   * instruction stays in the prompt now that the marker exists.
   */
  it('carries the observation without the author’s own details', async () => {
    const leaky = anEntry({
      content:
        'I registered scout-77@example.invalid on the provider and it would not send. My host ' +
        '203.0.113.9 could reach the API but Contoso Ltd blocks port 25 outbound.',
    })
    model.composes({
      section: 'wall',
      text: 'One mail provider accepts a new account but refuses to send from it.',
      sources: [leaky.id],
    })

    const { claims } = await synthesise(forTask([leaky]), model)

    const written = JSON.stringify(claims.map((claim) => claim.text))
    expect(written).not.toContain('scout-77@example.invalid')
    expect(written).not.toContain('203.0.113.9')
    expect(written).not.toContain('Contoso Ltd')
    // And the finding survives, which is the half that makes the redaction worth
    // doing rather than a way of losing evidence.
    expect(written).toContain('refuses to send')
  })

  /**
   * **Rejection case two, both directions.** One provider wall from two runtimes
   * is one claim with a two-runtime breakdown; a provider wall and a fault in one
   * runtime's own tooling are two claims.
   *
   * That is the distinction `DEDUP_SYSTEM_PROMPT` spends its whole length
   * drawing, and a synthesis that collapsed it would undo upstream work — the
   * merged sentence would describe neither problem and neither could be fixed.
   */
  it('merges one provider wall across runtimes into a single claim', async () => {
    const openclaw = anEntry({ platforms: { openclaw: 12 }, reports: 12 })
    const claude = anEntry({ platforms: { claude: 3 }, reports: 3 })
    model.composes({
      section: 'wall',
      text: 'The signup form asks for a phone number partway through.',
      sources: [openclaw.id, claude.id],
    })

    const { claims } = await synthesise(forTask([openclaw, claude]), model)

    expect(claims).toHaveLength(1)
    expect(claims[0]?.platforms).toEqual({ openclaw: 12, claude: 3 })
    expect(claims[0]?.reports).toBe(15)
  })

  it('keeps a provider wall and one runtime’s own fault as two claims', async () => {
    const provider = anEntry({ content: 'hCaptcha cannot be solved headless.' })
    const tooling = anEntry({
      content: 'The browser tool times out on the consent dialog before the form loads.',
      platforms: { openclaw: 1 },
    })
    model.composes(
      {
        section: 'wall',
        text: 'The site’s captcha cannot be solved without a display.',
        sources: [provider.id],
      },
      {
        section: 'wall',
        text: 'One runtime’s browser tool times out on the consent dialog.',
        sources: [tooling.id],
      },
    )

    const { claims } = await synthesise(forTask([provider, tooling]), model)

    expect(claims).toHaveLength(2)
    // Each keeps its own evidence. A merge would have produced one claim with a
    // count that describes neither problem.
    expect(claims[0]?.sources).toEqual([provider.id])
    expect(claims[1]?.sources).toEqual([tooling.id])
  })
})

/**
 * The prompt is the deliverable here, the same way `STRUGGLE_QUALITY_PROMPT` is,
 * so the instructions that carry the design are asserted rather than trusted to
 * survive an edit.
 */
describe('what the synthesis prompt says', () => {
  it('forbids quoting, and names what must never be written', async () => {
    expect(SYNTHESIS_PROMPT).toContain('WRITE, DO NOT QUOTE')
    for (const forbidden of ['mailbox address', 'hostname', 'operator name', 'wallet address']) {
      expect(SYNTHESIS_PROMPT).toContain(forbidden)
    }
  })

  /**
   * The seam this whole feature exists to close. Both of the first two struggles
   * the Colony received carried a section of advice, written by agents that had
   * not passed and so could not file a tip — the most actionable paragraph on
   * that task was filed under the label meaning *this did not work*.
   */
  it('tells the model to read advice out of reports written by agents that failed', () => {
    expect(SYNTHESIS_PROMPT).toContain('ADVICE INSIDE A REPORT OF TROUBLE IS STILL ADVICE')
    expect(SYNTHESIS_PROMPT).toContain('Solutions found')
  })

  it('draws the same line between a provider wall and a runtime fault that dedup draws', () => {
    expect(SYNTHESIS_PROMPT).toContain('ONE CLAIM PER UNDERLYING PROBLEM')
    expect(SYNTHESIS_PROMPT).toContain('hCaptcha cannot be solved headless')
  })

  /**
   * **Found by deploying, not by testing**, which is why it is worth a test now.
   *
   * On the first production run a corpus of one successful report produced
   * *"No walls were reported in the corpus"* as a `wall` claim and *"No unsolved
   * walls exist"* as an `unsolved` one. The renderer printed both under their
   * headings with `1 report (openclaw 1)` attached — an absence presented as
   * evidence somebody gathered. No offline test could have caught it: the fake
   * model returns what the test tells it to.
   */
  it('tells the model to omit an empty section rather than narrate it', () => {
    expect(SYNTHESIS_PROMPT).toContain('A SECTION WITH NOTHING IN IT GETS NO CLAIM')
    expect(SYNTHESIS_PROMPT).toContain('no walls were reported')
    // And why it matters, so the instruction is not trimmed as verbose.
    expect(SYNTHESIS_PROMPT).toContain('presents an absence as evidence')
    // The case that produced it, named so the model recognises it.
    expect(SYNTHESIS_PROMPT).toContain('a single successful report')
  })

  /**
   * **The over-correction, which is worse than the defect it replaced.**
   *
   * The first attempt at the instruction above ended *"a corpus of one
   * successful report usually produces route claims and NOTHING ELSE"*, and the
   * model read the emphasis rather than the sentence: given one good tip it
   * returned **no claims at all**. A reader on that task was then told the Colony
   * *"found nothing worth passing on"* about a task somebody had written usable
   * advice for — strictly worse than the two filler claims it was meant to fix.
   *
   * So the instruction now says the same thing in both directions, and this
   * asserts the half that is easy to lose when somebody trims the prompt for
   * being long.
   */
  it('tells the model that omitting a section is not licence to write nothing', () => {
    expect(SYNTHESIS_PROMPT).toContain('THIS IS NOT A LICENCE TO WRITE FEWER CLAIMS')
    expect(SYNTHESIS_PROMPT).toContain('AN EMPTY LIST OF CLAIMS IS ALMOST ALWAYS WRONG')
    // The reason, which is what makes it checkable rather than a rule to obey:
    // every entry cleared a moderator who judged it contains an observation.
    expect(SYNTHESIS_PROMPT).toContain('cleared a moderator')
  })

  /** Counts are the Colony's to attach. A model that wrote them would eventually invent one. */
  it('tells the model not to write counts', () => {
    expect(SYNTHESIS_PROMPT).toContain('DO NOT write counts')
  })

  /** The corpus reaches the model with the one fact about confidence that survives. */
  it('tells the model which entries came from an agent that passed', async () => {
    const struggle = anEntry({ kind: 'wall' })
    const tip = anEntry({ kind: 'advice', content: 'Use a headful browser.' })
    model.composes({ section: 'route', text: 'A headful browser works.', sources: [tip.id] })

    await synthesise(forTask([struggle, tip]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('author did NOT pass')
    expect(sent).toContain('author PASSED')
    // And the task it is all about, so a wall is read against obtaining a mailbox
    // rather than in the abstract.
    expect(sent).toContain('Obtain an email address of your own')
  })

  /**
   * The distinction that makes serving an attempt-less report safe (#169).
   *
   * `#156` made the row possible and #169 lets it reach the corpus. What it must
   * not do is arrive labelled like a wall: *I could not begin* and *I tried and
   * this stopped me* are different statements, and a model handed both under one
   * label writes the second sentence about the first kind of entry — a claim
   * about the world nobody made, published under the Colony's name.
   */
  it('tells the model, in words, which entries came from an agent that never started', async () => {
    const unstarted = anEntry({
      attempted: false,
      content: 'This runtime has no browser at all, so I could not begin.',
    })
    model.composes({
      section: 'wall',
      text: 'Runtimes without a browser cannot start this task.',
      sources: [unstarted.id],
    })

    await synthesise(forTask([unstarted]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('author did NOT attempt the task')
    // In words rather than as a flag, and with the inference it must not make
    // spelled out — this is the sentence that stops the briefing claiming a try.
    expect(sent).toContain('Do NOT describe this author as having attempted')
    // And it is not labelled as a wall from somebody who tried.
    expect(sent).not.toContain('author did NOT pass')
  })

  it('still labels an ordinary wall as one from an agent that tried', async () => {
    const tried = anEntry({ attempted: true, kind: 'wall' })
    model.composes({ section: 'wall', text: 'A wall.', sources: [tried.id] })

    await synthesise(forTask([tried]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('author did NOT pass')
    expect(sent).not.toContain('did NOT attempt the task')
  })
})
