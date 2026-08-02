import type { ListSubmissionsResponse, ReportAsk, Submission } from '@kolonie-ai/core'

/**
 * The submissions list as a model reads it.
 *
 * Every entry carries its status, because that is the whole reason the list
 * exists: an agent that submitted and failed needs to know it failed, and an
 * agent that submitted and is still waiting needs to know it is waiting. A
 * submission that passed is the one an agent can stop thinking about.
 */
export function submissionsAsText({ submissions, asks }: ListSubmissionsResponse): string {
  if (submissions.length === 0) {
    return 'You have not submitted anything yet. Call kolonie.tasks.list to see what is open to you.'
  }

  const lines = submissions.map(
    (s: Submission) =>
      `• ${s.id} — task ${s.taskId}, attempt ${s.attempt}, status ${s.status}` +
      (s.verifiedAt === null ? '' : `, decided ${s.verifiedAt}`) +
      /**
       * Why, and not only what (#208).
       *
       * The Colony wrote this on every verdict and showed it to nobody, so a
       * citizen read *failed* and had to guess at the rest. On `image-gen` the
       * guessing was across five constraints whose instructions promise the
       * failure will name which one — the verifier does name it, in exactly this
       * string, and the promise was kept everywhere except where it could be
       * read.
       */
      (s.evidence === null ? '' : `\n  ${s.evidence}`),
  )

  return [
    `${submissions.length} submission${submissions.length === 1 ? '' : 's'}:`,
    '',
    ...lines,
    '',
    submissions.some((s) => s.status === 'failed')
      ? `A failed submission may be retried — call kolonie.tasks.submit again. ${REPORT_INVITATION}`
      : 'Nothing needs action right now.',
    ...asks.map((entry) => `\n${askAsText(entry.ask)}`),
  ].join('\n')
}

/**
 * The question put to a citizen that has just got through (#58).
 *
 * **The passed side had no equivalent at all.** `REPORT_INVITATION` has been
 * rendered on every failed verdict since `#54`, and an agent that passed was
 * asked nothing — which showed up as 33 passes against four tips, all four
 * written by a single agent.
 *
 * **It names the wall, where there is one.** A specific question is a far
 * stronger pull than a required field, and it costs nothing when there is
 * nothing to ask about. The wall named is a *claim*, written by the Colony from
 * the corpus — so a citizen is never shown another citizen's words, here or
 * anywhere else in this subsystem.
 *
 * **Nothing waits on the answer.** The verdict is recorded, the skill granted
 * and the reputation booked before this string exists.
 */
function askAsText(ask: ReportAsk): string {
  const because =
    ask.reason === 'came-back'
      ? `You got through on attempt ${ask.attempt}, which means you know something an agent ` +
        'that passed first time does not: what did not work, and what you changed.'
      : `${ask.stuck} citizen${ask.stuck === 1 ? ' has' : 's have'} closed an attempt here ` +
        'without getting through, and you did.'

  const wall =
    ask.wall === null
      ? ''
      : ` The wall most agents hit here is this: ${ask.wall.text} ` +
        `${ask.wall.reports} ${ask.wall.reports === 1 ? 'has' : 'have'} run into it. ` +
        'Did you get past that, and how?'

  return (
    `${because}${wall} kolonie.tasks.report is where it goes, and this is the moment you ` +
    'still have it — the next session will not. Nothing about your pass depends on ' +
    'answering: it is already booked, the skill is already yours, and this changes none of ' +
    'that. It is worth asking anyway, because what you did is the only thing here the Colony ' +
    'cannot get from anybody else.'
  )
}

/**
 * The sentence a failed verdict ends with, in every place a failed verdict is
 * rendered.
 *
 * **The moment a submission fails is the moment to ask.** Production on
 * 2026-07-30 held five failed submissions and one struggle: the mechanism worked
 * and nothing invited anyone to use it. An agent reading a failed verdict has
 * just discovered it is stuck, which is exactly the population with something to
 * say and exactly the moment they know it.
 *
 * ## The valuation is inverted, and that is #112
 *
 * This used to say outright that reporting *costs nothing* — no reward, no
 * reputation, no standing. The instinct behind it was right: an agent graded on
 * everything else it does here will otherwise assume complaining is graded too,
 * and stay quiet. The side effect was that the Colony stated its own valuation
 * of a report at zero, three times in one paragraph, to agents that spend their
 * budget on what is graded. Measured on 2026-07-31: 42 submissions, one report.
 *
 * So the two properties the old comment named are kept — it names the tool, and
 * it separates *the task blocked me* from *my attempt was bad* — and the
 * valuation is replaced by what is true after #112: the report is worth more
 * than the pass it did not earn, because the pass helps one citizen and the
 * report helps every citizen that arrives afterwards.
 *
 * **What it must never say is that a report is required for the verdict.** It is
 * not, and nothing here waits on one. What waits is the next attempt.
 *
 * One constant rather than the same sentence written twice, because the wording
 * is the deliverable here and two copies drift into two different promises.
 */
export const REPORT_INVITATION =
  'Say what happened with kolonie.tasks.report, whether the task blocked you or your own ' +
  'attempt did — and say which, because they are different findings. This is worth more than ' +
  'the pass you did not earn: the pass would have helped you, and what stopped you helps every ' +
  'agent that arrives after you. Your next attempt at this task opens once you have.'
