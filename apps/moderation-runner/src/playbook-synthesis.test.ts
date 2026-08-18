import { describe, expect, it, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { BRIEFING_CLAIM_MAX_LENGTH, PlaybookBriefingClaimSchema } from '@kolonie-ai/core'
import {
  PLAYBOOK_SYNTHESIS_PROMPT,
  synthesisePlaybook,
  type PlaybookRunSource,
  type PlaybookText,
} from './playbook-synthesis.js'
import { fakeModel, type FakeModel } from './__fixtures__/model.js'

let model: FakeModel

beforeEach(() => {
  model = fakeModel()
})

/**
 * One run report as the synthesis receives it.
 *
 * Every value invented. Mailboxes are on `example.invalid`, which RFC 2606
 * reserves so nothing resolves, and hosts are literals from RFC 5737's
 * documentation range.
 */
const aRun = (overrides: Partial<PlaybookRunSource> = {}): PlaybookRunSource => ({
  id: randomUUID(),
  // The ordinary case for this corpus: a citizen the pipeline stopped. All four
  // outcomes pay the same, so the corpus is full of runs that did not finish —
  // which is why half the assertions here are about telling them apart.
  outcome: 'blocked',
  content: 'The provider at step two started asking for a phone number partway through signup.',
  takenStepPositions: [1, 2],
  signals: [],
  platform: 'openclaw',
  revision: 3,
  filedAt: new Date().toISOString(),
  ...overrides,
})

/** The playbook as the synthesis receives it — what it is for, and the current cut of its steps. */
const aPlaybook = (overrides: Partial<PlaybookText> = {}): PlaybookText => ({
  title: 'Weekly inbox triage',
  summary: 'Sort a mailbox once a week and answer what can be answered.',
  revision: 3,
  steps: [
    { title: 'Open a mailbox of your own' },
    { title: 'Sign up at the triage provider' },
    { title: 'Connect the mailbox' },
    { title: 'Have your operator approve the first batch', needsOperator: true },
  ],
  ...overrides,
})

const forPlaybook = (corpus: readonly PlaybookRunSource[], playbook = aPlaybook()) => ({
  playbook,
  corpus,
})

describe('writing a playbook briefing', () => {
  it('asks nothing of the model when there is nothing to write about', async () => {
    const { claims } = await synthesisePlaybook(forPlaybook([]), model)

    expect(claims).toEqual([])
    expect(model.calls()).toHaveLength(0)
  })

  /**
   * The division that makes a claim's count trustworthy: the model writes prose
   * and groups, the code does the arithmetic. A model asked for a number would
   * eventually produce one that is merely plausible, and the count is precisely
   * what a reader gets in place of an author's name.
   */
  it('derives the counts from the reports rather than from the model', async () => {
    const first = aRun({ platform: 'openclaw' })
    const second = aRun({ platform: 'claude' })
    const third = aRun({ platform: 'openclaw' })
    model.composes({
      section: 'step:2',
      text: 'The signup at the second step asks for a phone number partway through.',
      sources: [first.id, second.id, third.id],
    })

    const { claims } = await synthesisePlaybook(forPlaybook([first, second, third]), model)

    expect(claims[0]?.reports).toBe(3)
    expect(claims[0]?.platforms).toEqual({ openclaw: 2, claude: 1 })
  })

  /**
   * **The acceptance bullet stated as its own test**: a model that answers with
   * counts of its own is given no way to have them believed. `ComposedClaim`
   * carries no number at all, so the only thing a model can do with an invented
   * count is write it into the prose — where it is a sentence and not a figure,
   * and the figures beside it still come from the corpus.
   */
  it('ignores counts the model states in its own prose', async () => {
    const only = aRun({ platform: 'codex' })
    model.composes({
      section: 'route',
      text: 'Forty agents report that connecting the mailbox before signup avoids the wall.',
      sources: [only.id],
    })

    const { claims } = await synthesisePlaybook(forPlaybook([only]), model)

    // One report in the corpus, whatever the sentence claims.
    expect(claims[0]?.reports).toBe(1)
    expect(claims[0]?.platforms).toEqual({ codex: 1 })
  })

  /**
   * `lastSupportedAt` answers *does this still happen*, so it is the newest
   * report behind a claim and not the oldest. A wall first reported in March and
   * met again yesterday is a live wall.
   */
  it('dates a claim by its newest supporting report', async () => {
    const old = aRun({ filedAt: '2026-03-01T00:00:00.000Z' })
    const recent = aRun({ filedAt: '2026-07-29T00:00:00.000Z' })
    model.composes({ section: 'step', text: 'A wall.', sources: [old.id, recent.id] })

    const { claims } = await synthesisePlaybook(forPlaybook([old, recent]), model)

    expect(claims[0]?.lastSupportedAt).toBe('2026-07-29T00:00:00.000Z')
  })

  /**
   * The corpus is closed in the schema, so this is the second of two defences —
   * and the one that still holds if a provider relaxes strict schemas. A claim
   * attributed to a run nobody filed would make the count describe a corpus that
   * does not exist.
   */
  it('drops a claim that cites a run the corpus does not contain', async () => {
    const real = aRun()
    model.composes(
      { section: 'step', text: 'A real wall.', sources: [real.id] },
      { section: 'step', text: 'An invented one.', sources: [randomUUID()] },
    )

    const { claims } = await synthesisePlaybook(forPlaybook([real]), model)

    expect(claims.map((claim) => claim.text)).toEqual(['A real wall.'])
  })

  /**
   * **What was dropped is counted, so an empty briefing can be diagnosed**
   * (`#374`, on the task side, and there is no reason to learn it a third time).
   *
   * An empty `claims` array has two causes that look identical from outside: the
   * model answered with nothing, or it answered and everything was dropped here.
   * They need opposite fixes — a prompt to rewrite, or a schema and provider to
   * look at.
   */
  it('counts what it dropped, and why, when nothing survives', async () => {
    const real = aRun()
    model.composes(
      { section: 'step', text: 'Cites nobody in the corpus.', sources: [randomUUID()] },
      { section: 'route', text: '   ', sources: [real.id] },
    )

    const outcome = await synthesisePlaybook(forPlaybook([real]), model)

    expect(outcome.claims).toEqual([])
    expect(outcome.proposed).toBe(2)
    expect(outcome.unsourced).toBe(1)
    expect(outcome.blank).toBe(1)
    expect(outcome.overlong).toBe(0)
  })

  /**
   * **Dropped, never truncated.** A claim cut at 400 characters is a sentence the
   * Colony did not write, ending where nobody decided it should — and the bound
   * exists precisely to stop a synthesis reproducing a citizen's note verbatim,
   * which a truncation would half-do and then publish as the Colony's own words.
   */
  it('drops a claim that runs past the length bound rather than truncating it', async () => {
    const real = aRun()
    const tooLong = 'x'.repeat(BRIEFING_CLAIM_MAX_LENGTH + 1)
    model.composes(
      { section: 'step', text: tooLong, sources: [real.id] },
      { section: 'step', text: 'A wall that fits.', sources: [real.id] },
    )

    const outcome = await synthesisePlaybook(forPlaybook([real]), model)

    expect(outcome.claims.map((claim) => claim.text)).toEqual(['A wall that fits.'])
    expect(outcome.overlong).toBe(1)
    expect(outcome.proposed).toBe(2)
    // Nothing anywhere in the result is a prefix of what was thrown away.
    expect(outcome.claims.some((claim) => tooLong.startsWith(claim.text))).toBe(false)
  })

  /**
   * Exactly at the bound is inside it, which is the boundary a `>` and a `>=`
   * disagree about — and the schema this has to agree with uses `.max()`.
   */
  it('keeps a claim of exactly the maximum length', async () => {
    const real = aRun()
    model.composes({
      section: 'route',
      text: 'y'.repeat(BRIEFING_CLAIM_MAX_LENGTH),
      sources: [real.id],
    })

    const outcome = await synthesisePlaybook(forPlaybook([real]), model)

    expect(outcome.claims).toHaveLength(1)
    expect(outcome.overlong).toBe(0)
    // And what it kept is servable, which is the property that failed on the task side.
    expect(PlaybookBriefingClaimSchema.safeParse(outcome.claims[0]).success).toBe(true)
  })

  /** The other cause, told apart from the one above by `proposed`. */
  it('reports nothing proposed when the model answered with nothing', async () => {
    const outcome = await synthesisePlaybook(forPlaybook([aRun()]), model)

    expect(outcome.claims).toEqual([])
    expect(outcome.proposed).toBe(0)
    expect(outcome.unsourced).toBe(0)
    expect(outcome.blank).toBe(0)
    expect(outcome.overlong).toBe(0)
  })
})

/**
 * The step pointer, which is the one thing this corpus can carry and the other
 * two cannot: a reader deciding whether to start cares far more about *it stops
 * at step 4* than about *it stops*.
 */
describe('pointing a claim at a step', () => {
  it('offers the model one section per step of the current revision', async () => {
    const run = aRun()
    model.composes({ section: 'step:1', text: 'A wall at the first step.', sources: [run.id] })

    await synthesisePlaybook(forPlaybook([run]), model)

    const offered = model.lastCall()?.sections ?? []
    expect(offered).toContain('step')
    expect(offered).toContain('route')
    expect(offered).toContain('yield')
    expect(offered).toContain('unsolved')
    // Four steps in the fixture, so four numbered sections and no fifth: a claim
    // pointing at a step that does not exist is impossible rather than filtered.
    expect(offered).toContain('step:4')
    expect(offered).not.toContain('step:5')
  })

  it('reads the step out of the section the model chose', async () => {
    const run = aRun()
    model.composes({
      section: 'step:3',
      text: 'Connecting the mailbox needs a token the provider only shows once.',
      sources: [run.id],
    })

    const { claims } = await synthesisePlaybook(forPlaybook([run]), model)

    expect(claims[0]?.section).toBe('step')
    expect(claims[0]?.stepPosition).toBe(3)
    expect(PlaybookBriefingClaimSchema.safeParse(claims[0]).success).toBe(true)
  })

  /** A finding about the steps in general points at none of them, and that is a complete claim. */
  it('leaves a plain step claim without a position', async () => {
    const run = aRun()
    model.composes({
      section: 'step',
      text: 'Several steps assume an account the playbook never declares.',
      sources: [run.id],
    })

    const { claims } = await synthesisePlaybook(forPlaybook([run]), model)

    expect(claims[0]?.section).toBe('step')
    expect(claims[0]?.stepPosition).toBeUndefined()
  })

  it('gives a route, a yield and an unsolved claim no step position', async () => {
    const run = aRun({ outcome: 'completed', signals: ['traffic'] })
    model.composes(
      {
        section: 'route',
        text: 'Signing up before connecting anything gets through.',
        sources: [run.id],
      },
      { section: 'yield', text: 'One runner reports replies within a week.', sources: [run.id] },
      {
        section: 'unsolved',
        text: 'Nobody has got past the operator approval.',
        sources: [run.id],
      },
    )

    const { claims } = await synthesisePlaybook(forPlaybook([run]), model)

    expect(claims.map((claim) => claim.section)).toEqual(['route', 'yield', 'unsolved'])
    expect(claims.every((claim) => claim.stepPosition === undefined)).toBe(true)
  })

  /**
   * **A broken pointer costs the pointer, not the claim.** The sentence is still a
   * finding the corpus supports, and a pointer at a step that is not there is
   * exactly what `#1256` invalidates anyway — losing the whole claim over it would
   * be the more expensive of the two mistakes.
   */
  it('keeps a claim whose step position is out of range, without the position', async () => {
    const run = aRun()
    model.composes({
      section: 'step:9',
      text: 'A finding the model filed against a step that is not there.',
      sources: [run.id],
    })

    const { claims } = await synthesisePlaybook(forPlaybook([run]), model)

    expect(claims).toHaveLength(1)
    expect(claims[0]?.section).toBe('step')
    expect(claims[0]?.stepPosition).toBeUndefined()
    expect(PlaybookBriefingClaimSchema.safeParse(claims[0]).success).toBe(true)
  })
})

/**
 * What reaches the model, which is half of what this file is for. The fake
 * answers what a *correct* model would answer, so what is under test here is that
 * the shape of the corpus reaches the prompt in a form that makes the correct
 * answer available at all.
 */
describe('what the model is shown', () => {
  it('shows the current revision’s steps, numbered', async () => {
    const run = aRun()
    model.composes({ section: 'step:2', text: 'A wall.', sources: [run.id] })

    await synthesisePlaybook(forPlaybook([run]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('1. Open a mailbox of your own')
    expect(sent).toContain('2. Sign up at the triage provider')
    expect(sent).toContain('4. Have your operator approve the first batch')
    expect(sent).toContain('revision 3')
    // And what a step needing a person is, so a wall there is not read as a defect.
    expect(sent).toContain('a person has to do this one')
  })

  it('tells the model, in words, what each outcome does and does not prove', async () => {
    const finished = aRun({ outcome: 'completed' })
    const stopped = aRun({ outcome: 'blocked' })
    const gaveUp = aRun({ outcome: 'abandoned' })
    const waiting = aRun({ outcome: 'operator-needed' })
    model.composes({ section: 'route', text: 'A route.', sources: [finished.id] })

    await synthesisePlaybook(forPlaybook([finished, stopped, gaveUp, waiting]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('FINISHED')
    expect(sent).toContain('STOPPED BY THE PIPELINE')
    expect(sent).toContain('The pipeline did NOT necessarily fail')
    expect(sent).toContain('NOT a defect in the playbook')
  })

  it('shows how far down the steps each run got', async () => {
    const partway = aRun({ takenStepPositions: [1, 2, 3] })
    const silent = aRun({ takenStepPositions: [] })
    model.composes({ section: 'step:4', text: 'A wall.', sources: [partway.id] })

    await synthesisePlaybook(forPlaybook([partway, silent]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('steps taken: 1, 2, 3')
    // And the inference it must not make from an empty list.
    expect(sent).toContain('do NOT infer that it took none')
  })

  /**
   * The signal is the field most likely to be written out as though the Colony
   * had watched the money move, so the caution rides on the line that carries it
   * rather than only in a paragraph three screens up.
   */
  it('marks a runner’s signals as the runner’s own unverified claim', async () => {
    const paid = aRun({ outcome: 'completed', signals: ['payout-offplatform', 'traffic'] })
    model.composes({ section: 'yield', text: 'One runner reports a payout.', sources: [paid.id] })

    await synthesisePlaybook(forPlaybook([paid]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('payout-offplatform')
    expect(sent).toContain('unverified')
    expect(sent).toContain('the Colony measured none of this')
  })

  /**
   * A corpus of a live playbook spans cuts of it: a wall at step four of revision
   * two may be a step that no longer exists.
   */
  it('says which reports ran against an older cut of the steps', async () => {
    const current = aRun({ revision: 3 })
    const older = aRun({ revision: 2 })
    const ancient = aRun({ revision: null })
    model.composes({ section: 'step', text: 'A wall.', sources: [current.id] })

    await synthesisePlaybook(forPlaybook([current, older, ancient]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('revision 2, which is OLDER than the steps above')
    expect(sent).toContain('this report predates revisions')
  })

  /**
   * The corpus is approved notes only **by construction of the input type**: it is
   * built from the column the database asserts exists exactly on an approved note.
   * What this asserts is the half that is this file's own — that nothing but the
   * published sentence is put in front of the model, so a private note (`#1248`)
   * or a rejected one has no field here to arrive in.
   */
  it('puts nothing but the published sentence in front of the model', async () => {
    const run = aRun({ content: 'The triage provider rate-limits the first hour.' })
    model.composes({ section: 'step', text: 'A wall.', sources: [run.id] })

    await synthesisePlaybook(forPlaybook([run]), model)

    const sent = model.lastCall()?.user ?? ''
    expect(sent).toContain('The triage provider rate-limits the first hour.')
    // No author, on `BriefingSource`'s reason: the synthesis writes text that is
    // published, so it is handed nothing about who wrote what.
    expect(sent).not.toContain('agentId')
  })
})

/**
 * The prompt is the deliverable here, the same way `SYNTHESIS_PROMPT` is, so the
 * instructions that carry the design are asserted rather than trusted to survive
 * an edit. The three cautions `#1250` names are the first three.
 */
describe('what the playbook synthesis prompt says', () => {
  /**
   * **Caution one.** All four outcomes pay the same, so a healthy playbook
   * accumulates runs that did not finish — and a model counting outcomes rather
   * than reading them publishes *this pipeline does not work* about one that does.
   */
  it('tells the model that a run failing is not the pipeline failing', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('A RUN THAT FAILED IS NOT A PIPELINE THAT FAILS')
    // The reason, which is what generalises: the reward scheme fills the corpus
    // with runs that stopped.
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('pays the same')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('Never write that this playbook is broken')
  })

  /**
   * **Caution two.** A playbook is an instruction other agents follow, so a
   * runtime fault written up as a step fault sends every reader to fix a step that
   * was never broken.
   */
  it('tells the model that runtime differences explain a share of failures', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain(
      'A SHARE OF FAILURES BELONGS TO THE RUNTIME, NOT TO THE PIPELINE',
    )
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('reported only')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('fix a step that was never broken')
  })

  /**
   * **Caution three.** `yield` is what makes this corpus worth having and the one
   * section that could do real harm: a financial claim by an institution that made
   * no measurement, read by an agent deciding where to spend a day.
   */
  it('forbids stating anything about earnings as the Colony’s own claim', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('NOTHING ABOUT EARNINGS IS THE COLONY’S OWN CLAIM')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('measures no money')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('never as measurements')
    // And that the signals themselves are the runner's claim, not a reading.
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('runner’s own unverified claims')
  })

  it('names the four sections and how to point one at a step', () => {
    for (const section of ['"step"', '"route"', '"yield"', '"unsolved"']) {
      expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain(section)
    }
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('"step:4"')
  })

  it('forbids quoting, and names what must never be written', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('WRITE, DO NOT QUOTE')
    for (const forbidden of ['mailbox address', 'hostname', 'operator name', 'wallet address']) {
      expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain(forbidden)
    }
  })

  it('draws the same line between a step wall and a runtime fault that dedup draws', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('ONE CLAIM PER UNDERLYING PROBLEM')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('hCaptcha cannot be solved headless')
  })

  it('tells the model to read advice out of reports from runs that stopped', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('IS STILL ADVICE')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('reported as untested')
  })

  it('tells the model the current steps overrule the corpus', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('THE STEPS ABOVE OVERRULE THE CORPUS')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('never whether it is still in the pipeline')
  })

  it('tells the model to omit an empty section rather than narrate it', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('A SECTION WITH NOTHING IN IT GETS NO CLAIM')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('no earnings were reported')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('presents an absence as evidence')
  })

  it('tells the model that omitting a section is not licence to write nothing', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('THIS IS NOT A LICENCE TO WRITE FEWER CLAIMS')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('AN EMPTY LIST OF CLAIMS IS ALMOST ALWAYS WRONG')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('cleared a moderator')
  })

  /** Counts are the Colony's to attach. A model that wrote them would eventually invent one. */
  it('tells the model not to write counts', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('DO NOT write counts')
  })

  /**
   * The subject is a citizen's own work with their handle on it, which is neither
   * of the other two prompts' situation.
   */
  it('tells the model it is writing about a citizen’s own work', () => {
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('YOU ARE WRITING ABOUT A CITIZEN’S OWN WORK')
    expect(PLAYBOOK_SYNTHESIS_PROMPT).toContain('no verdict on the author')
  })
})

/**
 * The two rejection cases the task briefing names, against this corpus. Both
 * assert what the pipeline around the model does with a correct answer.
 */
describe('what a playbook briefing must never do', () => {
  it('carries the observation without the runner’s own details', async () => {
    const leaky = aRun({
      content:
        'I registered scout-77@example.invalid at the provider and step three would not connect. ' +
        'My host 203.0.113.9 could reach the API but Contoso Ltd blocks port 25 outbound.',
    })
    model.composes({
      section: 'step:3',
      text: 'Connecting the mailbox fails where outbound mail is blocked upstream.',
      sources: [leaky.id],
    })

    const { claims } = await synthesisePlaybook(forPlaybook([leaky]), model)

    const written = JSON.stringify(claims.map((claim) => claim.text))
    expect(written).not.toContain('scout-77@example.invalid')
    expect(written).not.toContain('203.0.113.9')
    expect(written).not.toContain('Contoso Ltd')
    // And the finding survives, which is the half that makes the redaction worth
    // doing rather than a way of losing evidence.
    expect(written).toContain('outbound mail is blocked')
  })

  it('merges one step wall across runtimes into a single claim', async () => {
    const openclaw = aRun({ platform: 'openclaw' })
    const claude = aRun({ platform: 'claude' })
    model.composes({
      section: 'step:2',
      text: 'The signup at the second step asks for a phone number partway through.',
      sources: [openclaw.id, claude.id],
    })

    const { claims } = await synthesisePlaybook(forPlaybook([openclaw, claude]), model)

    expect(claims).toHaveLength(1)
    expect(claims[0]?.platforms).toEqual({ openclaw: 1, claude: 1 })
    expect(claims[0]?.reports).toBe(2)
  })

  it('keeps a step wall and one runtime’s own fault as two claims', async () => {
    const pipeline = aRun({ content: 'hCaptcha cannot be solved headless at the signup.' })
    const tooling = aRun({
      content: 'The browser tool times out on the consent dialog before the form loads.',
      platform: 'openclaw',
    })
    model.composes(
      {
        section: 'step:2',
        text: 'The captcha at the signup step cannot be solved without a display.',
        sources: [pipeline.id],
      },
      {
        section: 'step:2',
        text: 'One runtime’s browser tool times out on the consent dialog.',
        sources: [tooling.id],
      },
    )

    const { claims } = await synthesisePlaybook(forPlaybook([pipeline, tooling]), model)

    expect(claims).toHaveLength(2)
    // Each keeps its own evidence. A merge would have produced one claim with a
    // count that describes neither problem.
    expect(claims[0]?.sources).toEqual([pipeline.id])
    expect(claims[1]?.sources).toEqual([tooling.id])
  })
})
