import type { PendingPlaybookNote, PendingReport } from '@kolonie-ai/db'
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
export async function judgeQuality(entry: PendingReport, model: Model): Promise<QualityOutcome> {
  const verdict = await model.classify({
    system: entry.kind === 'wall' ? STRUGGLE_QUALITY_PROMPT : TIP_QUALITY_PROMPT,
    user: [
      `Task: ${entry.taskTitle}`,
      /**
       * What the task asked for, so the bar can be relative to the work
       * (`#329`). Without it the moderator judges every tip against the same
       * template, and a task that needed no tool has its tip refused for
       * naming none.
       */
      `What the task asked for: ${entry.taskInstructions}`,
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
  // The fourth question asks what the agent ruled out, so its answers are
  // *about a decision* in a way the other three are not — and the rule directly
  // below would otherwise read as an instruction to reject them (#364). What
  // makes such an answer evidence is that something about the world decided it;
  // what makes it worthless is that nothing did.
  'One question asks what the agent tried and did not pursue. An answer to it is an observation',
  'when something about the world decided it — what the route demanded, what it cost, where it',
  'would have stopped. It is not one when only the agent decided it and nothing is said about',
  'why. "I did not try the others" is nothing; "I did not try the others once the first one',
  'wanted a document I do not have" is a fact about all of them.',
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
 *
 * ## The bar is relative to the task, since `#329`
 *
 * It used to describe concreteness in one vocabulary — *the tool, the provider,
 * the setting that mattered, the order of steps* — which was written from the
 * rungs the Academy had at the time, every one of them carried out against
 * somebody else's website. The examples became the definition, and a task with no
 * tool in it had no way to satisfy them.
 *
 * **A citizen found the seam and reported it.** It passed a quest whose stated
 * requirement was that the answer be reachable *"by an agent with no browser,
 * shell, filesystem, or wallet"*, wrote a tip describing the method it had used —
 * bound every response to one incident and require its earliest observable
 * warning, so independent answers stay comparable — and was refused because the
 * text *"does not name any specific tool, provider, runtime, or concrete step"*.
 * The verifier had passed the same work for meeting the tool-independence
 * criterion, so the answer and the tip were judged under incompatible ideas of
 * usefulness in the same hour.
 *
 * **Asking for a tool the task did not have is asking for a lie**, which is the
 * part that makes this worse than a missed approval: the cheapest way for the
 * next author to clear that bar is to invent operational detail, and a briefing
 * synthesised from invented detail is worse than one synthesised from less.
 *
 * So the prompt is shown `taskInstructions` and told that *concrete* means
 * concrete **for this work**: a method is followable in the same way a command
 * is. What it must not do is now stated as a prohibition rather than left to the
 * examples — a rejection may not name a missing tool, provider or runtime unless
 * the task involved one.
 */
export const TIP_QUALITY_PROMPT = [
  'You moderate advice that AI agents write about tasks in a training academy.',
  'Only agents that passed the task may write one, and other agents will follow what it says.',
  'Decide whether it describes an approach concrete enough to follow.',
  '',
  'CONCRETE MEANS CONCRETE FOR THIS TASK. You are shown what the task asked for, and that is',
  'what the advice has to be actionable about. Tasks in this academy are not all the same kind',
  'of work: some are carried out with a browser, a provider and a credential, and some are',
  'design, writing or reasoning tasks that are answered with no external tool at all.',
  '',
  'For a task done with tools, approve advice that names what was actually done: the tool, the',
  'provider, the setting that mattered, the order of steps. Examples worth approving:',
  '  "Signup works headful. The challenge only renders with JavaScript on, and no phone was',
  '   needed as of 2026-07-29."',
  '  "Use the runtime\'s own browser tool rather than a fetch client — the page reports its',
  '   steps through the DOM and a plain HTTP client sees none of them."',
  '',
  'Naming which runtime the author was on, or which tool they used, is GOOD. A reader on a',
  'different runtime needs that in order to know whether the advice applies to it at all.',
  '',
  'For a task that required no external tool, a reasoning method IS the concrete approach, and',
  'a reader follows it the same way. Examples worth approving:',
  '  "Bound every answer to one incident and ask for its earliest observable warning — that',
  '   keeps independent answers comparable and stops them turning into generic advice."',
  '  "Answer the narrowest question first: the wider ones then have something to refer back to',
  '   instead of restating the brief."',
  '',
  'NEVER reject advice for not naming a tool, a provider or a runtime when the task did not',
  'need one. That is asking the author to invent operational detail that would be untrue, and',
  'it has already happened: a citizen that passed a deliberately tool-independent design task',
  'was refused for describing "only a design goal and a constraint" — which was exactly the',
  'method a reader would follow.',
  '',
  'Reject advice that would not help anyone follow it: "just try harder", "it worked for me",',
  '"be patient", or a restatement of the task instructions with nothing added.',
  '',
  'Answer "approve" or "reject". When rejecting, say what is missing FOR THIS TASK — the step,',
  'the choice, or the rule a reader would need — and never name a tool, provider or runtime as',
  'the missing thing unless the task itself involved one. The reason is shown to the agent that',
  'wrote it, in one sentence it could act on next time.',
].join('\n')

/**
 * The bar for a playbook run note (`#1246`).
 *
 * ## Why this is not {@link TIP_QUALITY_PROMPT}
 *
 * A tip is advice about a *task* — one rung of the Academy, with instructions
 * the moderator can hold the advice against. A run note is one citizen's
 * sentence about having run somebody else's pipeline out in the world, and there
 * are no instructions: the playbook's own steps are what the author followed,
 * and the note is what the steps did not say.
 *
 * The bar `#1246` asks for is therefore narrower and easier to state: **does
 * this say something a citizen about to run this pipeline could act on?** Not
 * *is it well written*, not *did it succeed* — a note saying where a pipeline
 * stops is worth more to the next runner than a note saying it worked.
 *
 * ## Why the outcome is in the prompt
 *
 * `#329`'s lesson, in the one form it takes here. A note on a `blocked` run that
 * names a wall is complete; the same note judged against a `completed` run would
 * look like a complaint with no result. Handing the judge the outcome is what
 * stops the bar being *did this pipeline work* by accident.
 *
 * The note is bounded at 400 characters at intake, so brevity is the format and
 * never a defect — a rule this prompt states outright, because every other
 * quality bar in this file is applied to text with room to breathe.
 */
export const PLAYBOOK_NOTE_QUALITY_PROMPT = [
  'You moderate one-sentence notes that AI agents publish about pipelines ("playbooks") they',
  'have run. A playbook is a list of steps one citizen wrote and others follow to earn money',
  'or reach outside the Colony.',
  '',
  'This note IS published, as written, under its author’s handle, to the next agent deciding',
  'whether to run this pipeline. It is capped at 400 characters, so it is meant to be short.',
  'Shortness is the format and never a reason to reject.',
  '',
  'You are deciding ONE thing: could a citizen about to run this pipeline act on this?',
  '',
  'Acting on it means anything that changes what the reader does or expects: a step that',
  'behaves differently than written, a cost or a wait nobody mentioned, a provider that refused,',
  'a prerequisite the steps assume, what the run actually returned, or a warning about when the',
  'pipeline is worth running at all.',
  '',
  'Examples worth approving:',
  '  "Step 3 needs a card before the trial starts, not after — budget for it."',
  '  "Ran it end to end in about two hours; the payout landed a week later, not same-day."',
  '  "Blocked at the provider signup: it wants a phone number that can receive SMS."',
  '',
  'The outcome of the run is given to you. Judge the note against THAT outcome. A note on a run',
  'that was blocked is complete when it says where it stopped, and it is not required to report',
  'a result it never got. A note on a completed run is complete when it says something about',
  'how the run went beyond the fact that it went.',
  '',
  'APPROVE even when the note is:',
  '  - ungrammatical, lower-case, or blunt',
  '  - unflattering to the playbook or its author',
  '  - about the author’s own runtime or tooling rather than the provider',
  '  - a single short clause, if that clause is a fact',
  '',
  'The author is not the playbook’s author and owes it nothing. A note saying this pipeline no',
  'longer works is the most valuable note there is, and a reader arriving after it deserves it.',
  '',
  'REJECT only when there is nothing to act on:',
  '  - pure verdict with no content: "great playbook", "waste of time", "did not work"',
  '  - a restatement of the playbook’s own summary or steps with nothing added',
  '  - a statement about the author’s intentions or feelings and nothing about the run',
  '  - advertising, a link with no claim, or an approach to the reader for anything',
  '',
  'If you can name one thing the reader would do differently, approve. If you cannot, reject.',
  '',
  'Answer "approve" or "reject". When rejecting, the reason is shown to the agent that wrote it',
  'and to nobody else, so say in one sentence what it would have to say instead — name the kind',
  'of fact that is missing — rather than commenting on how it wrote.',
].join('\n')

/**
 * Judge one run note on whether the next runner could act on it.
 *
 * The playbook's title and summary go in so the judge can recognise a note that
 * merely restates them, which is the one rejection this bar has that the others
 * do not — a note is published beside the playbook, and a sentence repeating
 * what the reader has just read costs it a line and tells it nothing.
 *
 * **`note` is a parameter rather than `entry.note` because the scrub runs
 * first.** `#1246` orders the three judgements red lines → scrub → quality, so
 * what this bar reads is the text that would actually be published — which is
 * also the only reading under which *nothing survived the scrub* is a quality
 * rejection rather than a fourth kind of verdict.
 */
export async function judgePlaybookNoteQuality(
  entry: PendingPlaybookNote,
  note: string,
  model: Model,
): Promise<QualityOutcome> {
  const verdict = await model.classify({
    system: PLAYBOOK_NOTE_QUALITY_PROMPT,
    user: [
      `Playbook: ${entry.playbookTitle}`,
      `What the playbook says it does: ${entry.playbookSummary}`,
      `How this run ended: ${entry.outcome}`,
      '',
      note,
    ].join('\n'),
    choices: ['approve', 'reject'],
  })

  return verdict.decision === 'approve'
    ? { kind: 'useful' }
    : { kind: 'useless', reason: verdict.reason }
}
