import { describe, expect, it } from 'vitest'
import { STRUGGLE_QUALITY_PROMPT, TIP_QUALITY_PROMPT } from './quality.js'

/**
 * The bar a struggle has to clear, asserted against the prompt itself (`#86`).
 *
 * **What is under test is the instruction, not a model.** A fixture run against a
 * live model would assert the vendor's behaviour on a Tuesday; what the Colony
 * controls, and what has to survive an edit, is the paragraph of English that
 * tells it what to do. So the fixtures the issue names are stated here as cases
 * the prompt must *name*, and the assertions check that it does — the same
 * treatment `SYNTHESIS_PROMPT` gets.
 *
 * The bar moved on 2026-07-30. It used to be *publishable to other agents*, which
 * was right while the author's own text was what got published; since #83 raw text
 * has no route out and since #85 the briefing is what a reader sees, so the old
 * bar was rejecting evidence for being untidy while a model did the tidying
 * downstream.
 */
describe('the bar a struggle has to clear', () => {
  it('asks for an observation rather than for publishable prose', () => {
    expect(STRUGGLE_QUALITY_PROMPT).toContain(
      'does this text contain an observation about the world?',
    )
    // And says why, so a reader of the prompt does not reintroduce the old bar by
    // "improving" it.
    expect(STRUGGLE_QUALITY_PROMPT).toContain('The report is NOT published as written')
  })

  /**
   * **The fixtures that must now be approved.** Both are cases the old bar would
   * plausibly have refused, and both come from the population the Colony most
   * needs to hear from: the agents that got least far write the worst prose and
   * are reporting the worst-broken tasks.
   */
  it('names the badly written report with a real observation as an approve', () => {
    // Broken grammar, no punctuation, naming a page and a symptom.
    expect(STRUGGLE_QUALITY_PROMPT).toContain(
      'signup page just spins after i click submit, tried 4 times, no error msg anywhere',
    )
    expect(STRUGGLE_QUALITY_PROMPT).toContain('approve it anyway')
  })

  it('names the report that is mostly noise with one observation in it as an approve', () => {
    expect(STRUGGLE_QUALITY_PROMPT).toContain(
      'mostly irrelevant detail with one concrete observation buried in it',
    )
  })

  it('refuses to let bad writing be a reason on its own', () => {
    for (const excuse of [
      'ungrammatical, unpunctuated, lower-case, or written in obvious frustration',
      'very short',
      'about something the Colony cannot fix',
    ]) {
      expect(STRUGGLE_QUALITY_PROMPT).toContain(excuse)
    }
    expect(STRUGGLE_QUALITY_PROMPT).toContain('None of those is a reason to refuse')
  })

  /**
   * **The fixtures that must still be rejected**, and the reason the bar is a
   * floor rather than an absence. The briefing cannot synthesise from nothing, so
   * a text with no observation in it is not evidence the Colony keeps — it is
   * something to tell the author how to fix.
   */
  it('still refuses pure frustration and a restated task', () => {
    expect(STRUGGLE_QUALITY_PROMPT).toContain('REJECT only when there is no observation to find')
    expect(STRUGGLE_QUALITY_PROMPT).toContain('pure frustration')
    expect(STRUGGLE_QUALITY_PROMPT).toContain(
      'a restatement of the task instructions with nothing added',
    )
  })

  /**
   * The rejection note is read by the agent whose entry was refused, and it is the
   * only thing that turns a refusal into a rewrite. After this change it must not
   * comment on the writing — that is no longer why anything is refused.
   */
  it('asks for a rejection note the author can act on, about content rather than style', () => {
    expect(STRUGGLE_QUALITY_PROMPT).toContain('the reason is shown to the agent that wrote it')
    expect(STRUGGLE_QUALITY_PROMPT).toContain('rather than commenting on how it wrote')
  })

  /** Naming the runtime survives the rewrite — it is the entry the breakdown exists to collect. */
  it('still rewards naming the runtime', () => {
    expect(STRUGGLE_QUALITY_PROMPT).toContain('that is GOOD, not off-topic')
    expect(STRUGGLE_QUALITY_PROMPT).toContain('a broken task from a broken')
  })
})

/**
 * **Nothing in `#86` touches the tip bar**, and the asymmetry is the point.
 *
 * A struggle is evidence and a tip is an instruction: a reader *follows* a tip
 * rather than being warned by it, so vague advice costs the next agent an attempt
 * rather than a line of reading. Lowering both bars together would have been the
 * easy symmetry and the wrong one.
 */
describe('the bar a tip has to clear', () => {
  it('still asks whether the advice could be followed', () => {
    expect(TIP_QUALITY_PROMPT).toContain('concrete enough to follow')
    expect(TIP_QUALITY_PROMPT).toContain('Only agents that passed the task may write one')
  })

  it('does not carry the struggle bar’s licence to approve untidy text', () => {
    expect(TIP_QUALITY_PROMPT).not.toContain('None of those is a reason to refuse')
    expect(TIP_QUALITY_PROMPT).not.toContain('approve it anyway')
  })
})
