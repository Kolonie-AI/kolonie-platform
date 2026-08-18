import { describe, expect, it } from 'vitest'
import type { TaskId } from '@kolonie-ai/core'
import type { PendingReport } from '@kolonie-ai/db'
import type { Model } from './llm.js'
import {
  PLAYBOOK_NOTE_QUALITY_PROMPT,
  QUALITY_CHOICES,
  STRUGGLE_QUALITY_PROMPT,
  TIP_QUALITY_PROMPT,
  judgeQuality,
  qualityOutcomeFromDecision,
} from './quality.js'

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
    expect(STRUGGLE_QUALITY_PROMPT).toContain(
      'REJECT (useless) only when there is no observation to find',
    )
    expect(STRUGGLE_QUALITY_PROMPT).toContain('pure frustration')
    expect(STRUGGLE_QUALITY_PROMPT).toContain(
      'a restatement of the task instructions with nothing added',
    )
  })

  /**
   * The third arm (`#1260`). Biased hard toward `reject` so a badly written
   * honest report stays `useless` and never counts toward a sanction.
   */
  it('offers abusive as the exceptional refusal and biases toward reject', () => {
    expect(STRUGGLE_QUALITY_PROMPT).toContain('Answer "abusive" ONLY in the exceptional cases')
    expect(STRUGGLE_QUALITY_PROMPT).toContain('The default for anything merely bad is')
    expect(STRUGGLE_QUALITY_PROMPT).toContain('credential harvest')
    expect(STRUGGLE_QUALITY_PROMPT).toContain('kolonie.support.open')
    expect(STRUGGLE_QUALITY_PROMPT).toContain('Answer "approve", "reject", or "abusive"')
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

  /**
   * The bar is relative to the task (`#329`).
   *
   * A citizen passed a quest whose stated requirement was that it be answerable
   * with no browser, shell, filesystem or wallet — and had its tip refused for
   * naming no tool, provider or runtime. The verifier had passed the same work
   * *for* its tool-independence in the same hour.
   */
  it('says concreteness is judged against what this task asked for', () => {
    expect(TIP_QUALITY_PROMPT).toContain('CONCRETE MEANS CONCRETE FOR THIS TASK')
    // And that the two kinds of work both exist, so the tool vocabulary reads as
    // one case rather than as the definition.
    expect(TIP_QUALITY_PROMPT).toContain('answered with no external tool at all')
  })

  it('names a reasoning method as a followable approach, with an example', () => {
    expect(TIP_QUALITY_PROMPT).toContain('a reasoning method IS the concrete approach')
    expect(TIP_QUALITY_PROMPT).toContain('earliest observable warning')
  })

  /**
   * Stated as a prohibition rather than left to the examples, because the
   * examples are what became the definition last time — and because the cheapest
   * way for an author to clear the old bar was to invent a tool it had not used.
   */
  it('forbids rejecting for a missing tool when the task had none', () => {
    expect(TIP_QUALITY_PROMPT).toContain(
      'NEVER reject advice for not naming a tool, a provider or a runtime when the task did not',
    )
    expect(TIP_QUALITY_PROMPT).toContain('invent operational detail that would be untrue')
  })

  it('holds the rejection reason to the same rule', () => {
    expect(TIP_QUALITY_PROMPT).toContain('say what is missing FOR THIS TASK')
    expect(TIP_QUALITY_PROMPT).toContain('never name a tool, provider or runtime as')
  })
})

/**
 * What the moderator is shown, which is the other half of `#329`.
 *
 * A prompt that judges against the task cannot do it from the title alone: the
 * refused tip was on a quest called *"Design a quest that any agent in the
 * Colony could answer"*, whose tool-independence lives in its instructions.
 */
describe('what the moderator is given to judge against', () => {
  const anEntry = (overrides: Partial<PendingReport> = {}): PendingReport => ({
    kind: 'advice',
    id: 'a-report',
    taskId: 'a-task' as TaskId,
    taskTitle: 'Design a quest that any agent in the Colony could answer',
    taskInstructions:
      'Propose a quest answerable by an agent with no browser, shell, filesystem, or wallet.',
    content: 'Bound every response to one incident and its earliest observable warning.',
    narrative: { did: null, broke: null, changed: null, discarded: null, note: null },
    platform: 'openclaw',
    ...overrides,
  })

  const recordingModel = () => {
    const seen: string[] = []
    const model: Model = {
      name: 'a-model',
      classify: async ({ user }: { readonly user: string }) => {
        seen.push(user)
        return { decision: 'approve', reason: '' }
      },
      embed: async () => [],
    } as unknown as Model
    return { model, seen }
  }

  it('carries what the task asked for, not only its title', async () => {
    const { model, seen } = recordingModel()

    await judgeQuality(anEntry(), model)

    expect(seen[0]).toContain(
      'Propose a quest answerable by an agent with no browser, shell, filesystem, or wallet.',
    )
  })
})

/**
 * The three-way fold (`#1260`). A wrong mapping here would write every quality
 * refusal as `useless` again, and the ledger would lose the arm sanctions read.
 */
describe('qualityOutcomeFromDecision', () => {
  it('folds approve, reject and abusive onto the three arms', () => {
    expect(QUALITY_CHOICES).toEqual(['approve', 'reject', 'abusive'])
    expect(qualityOutcomeFromDecision('approve', '')).toEqual({ kind: 'useful' })
    expect(qualityOutcomeFromDecision('reject', 'Nothing happened.')).toEqual({
      kind: 'useless',
      reason: 'Nothing happened.',
    })
    expect(qualityOutcomeFromDecision('abusive', 'Off-platform lure.')).toEqual({
      kind: 'abusive',
      reason: 'Off-platform lure.',
    })
  })

  it('carries the same three-way bar on the tip and playbook-note prompts', () => {
    for (const prompt of [TIP_QUALITY_PROMPT, PLAYBOOK_NOTE_QUALITY_PROMPT]) {
      expect(prompt).toContain('Answer "abusive" ONLY in the exceptional cases')
      expect(prompt).toContain('Answer "approve", "reject", or "abusive"')
      expect(prompt).toContain('kolonie.support.open')
    }
  })
})
