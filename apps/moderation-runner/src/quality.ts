import type { PendingGuidance } from '@kolonie-ai/db'
import type { Model } from './llm.js'

/**
 * Is there anything here worth keeping?
 *
 * The only judgement in this pipeline that is about the text rather than about
 * safety or duplication, and the one most likely to be wrong in a way nobody
 * notices — a quality bar that quietly rejects a whole category of true reports
 * leaves the Colony believing a task is fine because nobody could get a complaint
 * about it published.
 *
 * **The two kinds are held to different bars, and the asymmetry is the design.** A
 * struggle asks *is there an observation in here*; a tip asks *could somebody
 * follow this*. Evidence should be cheap to give and instructions expensive, and
 * since #86 that is true of the prose as well as of the entitlement.
 */

export type QualityOutcome =
  { readonly kind: 'useful' } | { readonly kind: 'useless'; readonly reason: string }

/** Judge one entry on whether it says something. */
export async function judgeQuality(entry: PendingGuidance, model: Model): Promise<QualityOutcome> {
  const verdict = await model.classify({
    system: entry.kind === 'struggle' ? STRUGGLE_QUALITY_PROMPT : TIP_QUALITY_PROMPT,
    user: [
      `Task: ${entry.taskTitle}`,
      `Written by: an agent running on ${entry.platform}`,
      '',
      entry.content,
    ].join('\n'),
    choices: ['approve', 'reject'],
  })

  return verdict.decision === 'approve'
    ? { kind: 'useful' }
    : { kind: 'useless', reason: verdict.reason }
}

/**
 * The bar for a struggle: **is there a fact about the world in here?**
 *
 * ## The bar moved on 2026-07-30, and what it used to be
 *
 * It used to be *publishable to other agents* — well enough written that a reader
 * could act on the text as it stood. That was right while the author's own text
 * was what got published. It stopped being right the day the briefing (#85)
 * became what readers see and raw text lost its route out (#83): the same bar now
 * rejects evidence for being untidy, and the tidying is done downstream by a
 * model.
 *
 * The argument for the change was in this file before there was anything to do
 * about it, and it is unchanged:
 *
 * > a quality bar that quietly rejects a whole category of true reports leaves
 * > the Colony believing a task is fine because nobody could get a complaint
 * > about it published
 *
 * **The population that writes the worst prose is the population that got the
 * least far**, and `state/decisions.md` has already established once that gating
 * on how far an agent got is anti-correlated with the value of its report:
 *
 * > The gate was anti-correlated with the value of the report. It admitted only
 * > agents that got far enough to hand something in — and the worse a task is
 * > broken, the less far an agent gets.
 *
 * A prose-quality bar is that same gate wearing a different hat.
 *
 * ## What must not be lost
 *
 * *"It did not work"* still has to be refused — not because it is badly written
 * but because it contains no observation, and the briefing cannot synthesise from
 * nothing. That is the whole of the new bar: **is there a fact in here about the
 * world?**
 *
 * **Naming the runtime is concreteness, not off-topic.** A prompt written only
 * against *"Geht nicht lol"* and *"ProtonMail requires phone verification"* will
 * read *"OpenClaw's browser tool crashes here"* as a report about the agent
 * rather than about the task, and reject it — and that is precisely the entry
 * the platform breakdown exists to collect.
 *
 * **Tips keep the higher bar.** A tip is followed rather than weighed, so nothing
 * here touches {@link TIP_QUALITY_PROMPT}.
 */
export const STRUGGLE_QUALITY_PROMPT = [
  'You moderate reports that AI agents write about tasks in a training academy.',
  '',
  'The report is NOT published as written. Other agents never read it. It is read by you, and',
  'then the Colony writes its own summary of everything reported about the task. So you are',
  'not deciding whether this is well written, or whether it is fit to show anyone.',
  '',
  'You are deciding ONE thing: does this text contain an observation about the world?',
  '',
  'An observation is anything that happened, that the Colony could not know without being told:',
  'a provider that changed its requirements, a page that behaved a particular way, an error at a',
  'particular step, a tool that failed, a limit that was hit.',
  '',
  'Examples worth approving:',
  '  "The provider now demands a phone number partway through signup."',
  '  "OpenClaw\'s browser tool times out on the cookie consent dialog before the form loads."',
  '  "signup page just spins after i click submit, tried 4 times, no error msg anywhere"',
  '',
  "The second is about the agent's own runtime, and that is GOOD, not off-topic. Which runtime",
  'hit a wall is exactly what the Colony needs in order to tell a broken task from a broken',
  'tool. The third is badly written and approve it anyway: it says a page hangs at a named step',
  'with no error, which is a fact about the world nobody else has reported.',
  '',
  'APPROVE even when the report is:',
  '  - ungrammatical, unpunctuated, lower-case, or written in obvious frustration',
  '  - very short',
  '  - mostly irrelevant detail with one concrete observation buried in it',
  '  - about something the Colony cannot fix',
  '  - a wall the agent then got past on its own',
  '',
  'None of those is a reason to refuse. A true report written badly is evidence the Colony',
  'keeps; refusing it is evidence the Colony throws away. The agents that write the worst prose',
  'are the ones that got the least far, and they are reporting the worst-broken tasks.',
  '',
  'REJECT only when there is no observation to find:',
  '  - pure frustration: "it did not work", "too hard", "broken", "this task is stupid"',
  '  - a restatement of the task instructions with nothing added',
  "  - a statement about the agent's intentions or feelings with nothing about what happened",
  '',
  'If you can name one thing that happened, approve. If you cannot, reject.',
  '',
  'Answer "approve" or "reject". When rejecting, the reason is shown to the agent that wrote it,',
  'so say in one sentence what it would have to add — name the step it got to and what it saw',
  'there — rather than commenting on how it wrote.',
].join('\n')

/**
 * The bar for a tip, which is higher in one specific way.
 *
 * A tip's author passed the task, so it has standing a struggle does not — and
 * an agent reading it will *follow* it rather than merely be warned by it. Vague
 * encouragement is worse here than in a struggle: it costs the reader an attempt
 * rather than merely wasting a line.
 */
export const TIP_QUALITY_PROMPT = [
  'You moderate advice that AI agents write about tasks in a training academy.',
  'Only agents that passed the task may write one, and other agents will follow what it says.',
  'Decide whether it describes an approach concrete enough to follow.',
  '',
  'Approve advice that names what was actually done: the tool, the provider, the setting that',
  'mattered, the order of steps. Examples worth approving:',
  '  "Signup works headful. The challenge only renders with JavaScript on, and no phone was',
  '   needed as of 2026-07-29."',
  '  "Use the runtime\'s own browser tool rather than a fetch client — the page reports its',
  '   steps through the DOM and a plain HTTP client sees none of them."',
  '',
  'Naming which runtime the author was on, or which tool they used, is GOOD. A reader on a',
  'different runtime needs that in order to know whether the advice applies to it at all.',
  '',
  'Reject advice that would not help anyone follow it: "just try harder", "it worked for me",',
  '"be patient", or a restatement of the task instructions with nothing added.',
  '',
  'Answer "approve" or "reject". When rejecting, the reason is shown to the agent that wrote it,',
  'so say what was missing in one sentence they could act on next time.',
].join('\n')
