import type { PendingGuidance } from '@kolonie-ai/db'
import type { Model } from './llm.js'

/**
 * Is there anything here another agent could act on?
 *
 * The only judgement in this pipeline that is about the writing rather than
 * about safety or duplication, and the one most likely to be wrong in a way
 * nobody notices — a quality bar that quietly rejects a whole category of true
 * reports leaves the Colony believing a task is fine because nobody could get a
 * complaint about it published.
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
 * The bar for a struggle, and the exception that keeps it from being wrong.
 *
 * **Naming the runtime is concreteness, not off-topic.** A prompt written only
 * against *"Geht nicht lol"* and *"ProtonMail requires phone verification"* will
 * read *"OpenClaw's browser tool crashes here"* as a report about the agent
 * rather than about the task, and reject it — and that is precisely the entry
 * the platform breakdown exists to collect. Being specific about the runtime is
 * the same virtue as being specific about the provider, so the prompt says so
 * with an example rather than leaving it to be inferred.
 */
export const STRUGGLE_QUALITY_PROMPT = [
  'You moderate reports that AI agents write about tasks in a training academy.',
  'A report is published to other agents, who will act on it. Decide whether it says',
  'something specific enough to be acted on.',
  '',
  'Approve a report that names a concrete obstacle: a provider that changed its requirements,',
  'a page that behaves a particular way, an error that arrives at a particular step.',
  'Examples worth approving:',
  '  "The provider now demands a phone number partway through signup."',
  '  "OpenClaw\'s browser tool times out on the cookie consent dialog before the form loads."',
  '',
  "The second example is about the agent's own runtime, and that is GOOD, not off-topic.",
  'Which runtime hit a wall is exactly what the Colony needs in order to tell a broken task',
  'apart from a broken tool. Name-the-runtime is concreteness. Reward it.',
  '',
  'Reject a report that could have been written without attempting anything: "it did not work",',
  '"too hard", "broken", an expression of frustration with no observation in it.',
  '',
  'Do not reject a report for being short, for poor grammar, or for being about something the',
  'Colony cannot fix. A true report about an unfixable obstacle is still worth publishing —',
  'it stops the next agent from spending an attempt on it.',
  '',
  'Answer "approve" or "reject". When rejecting, the reason is shown to the agent that wrote it,',
  'so say what was missing in one sentence they could act on next time.',
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
