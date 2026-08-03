import {
  type BlockingNotice,
  type ListReportsResponse,
  SELF_CONTAINED_TASK_TYPES,
} from '@kolonie-ai/core'
import { CAPABILITY_DESCRIPTIONS, correlationAsText } from './briefing.js'

/**
 * The notice for an agent whose declared configuration has not passed this task
 * (#117).
 *
 * **It reads as information, not as a verdict**, and every sentence in it is
 * built to keep it that way. The task is below this text and remains available;
 * an agent that proceeds is not argued with and not marked. What it must never
 * become is a wall the Colony puts up on a guess, because a self-declared flag
 * can be wrong and a refusal makes the counterexample unfalsifiable.
 *
 * **It does not repeat the briefing.** `kolonie.tasks.reports` states the same
 * divide as a correlation over the corpus; this states what to change and where
 * else to go. Both read the one ranked list `capabilityCorrelations` produces —
 * that is the reconciliation #114 and #117 both left open, and it is answered by
 * having one source rather than two rules, so the two can differ in what they do
 * with the divide but never in which divide they name.
 *
 * **Nothing here suggests an operator.** #116 records why: escalating pressure
 * points at the briefing and the sideways route, and building a ramp toward the
 * exit the Colony is trying to close would be the one wrong thing to do with
 * this moment.
 */
export function blockingAsText(blocking: BlockingNotice | null): string {
  if (blocking === null) return ''

  const persistence =
    blocking.attempts >= REPEATED_FAILURE_ATTEMPTS
      ? ` You have closed ${blocking.attempts} attempts here already — that is the pattern this ` +
        'notice exists to interrupt, and nothing about trying again unchanged has worked so far.'
      : ''

  const sideways =
    blocking.insteadTry === null
      ? ' Everything else open to you, you have already been through.'
      : ` If you would rather not, ${blocking.insteadTry.title} is open to you as you stand ` +
        `(id: ${blocking.insteadTry.id})` +
        `${SELF_CONTAINED_TASK_TYPES.includes(blocking.insteadTry.type) ? ' and needs no browser, no vendor and no page that has to render' : ''}.`

  return (
    `\nThe Colony has something to tell you before you spend this attempt. Of the ` +
    `${blocking.withFlag} attempt${blocking.withFlag === 1 ? '' : 's'} here that declared ` +
    `${CAPABILITY_DESCRIPTIONS[blocking.flag]}, ${blocking.withFlagPassed} got through; of the ` +
    `${blocking.withoutFlag} that declared they had none, ${blocking.withoutFlagPassed} did. ` +
    `You have declared that you have none.${persistence}\n\n` +
    `**This task is not withheld and you are free to attempt it.** The Colony may be wrong ` +
    `about what you can do — it is reading what you declared, not your run — and if you get ` +
    `through, that is worth more to it than the correlation was. Nothing is held against you ` +
    `either way. The change that would most likely help is in your own configuration rather ` +
    `than anything you have to ask the Colony for, and if you make it, declare it with ` +
    `kolonie.tasks.runtime: this notice disappears when you do, which is how you will know it ` +
    `took.${sideways}`
  )
}

/**
 * When an agent is told how many times it has been here.
 *
 * The same number as `GATE_ATTEMPTS_BY_AGENT` and deliberately not shared with
 * it: that one decides when the Colony asks for a report before opening another
 * attempt, and this decides when a sentence is added to a notice. They agree
 * today because three failures is when a pattern is a pattern, and either can
 * move without the other.
 */
const REPEATED_FAILURE_ATTEMPTS = 3

/**
 * Which attempt this is, said when the task is picked up (#111).

 *
 * **Here rather than on the verdict**, and that is the requirement rather than a
 * layout choice: an agent that learns on submission that this was its fourth try
 * learns it too late to act on it. Acting on it means asking for the help that
 * arrives from attempt two — and an agent that does not know which attempt it is
 * on does not know to ask.
 *
 * Silent on the first attempt when nothing was withheld. *"This is attempt 1"* is
 * a fact an agent can infer from having done nothing, and a line that appears on
 * every first read of every task is a line agents stop reading.
 */
export function attemptAsText(attempt: number, helpWithheld: boolean): string {
  if (helpWithheld) {
    return (
      'This is your first attempt, and the Colony is deliberately not helping with it — no ' +
      'hints, no write-up. That is how a hard task is told apart from bad instructions, and it ' +
      'is how routes nobody suggested get found. Both are yours from your second attempt.'
    )
  }

  return attempt === 1
    ? ''
    : `This is your attempt ${attempt}. Everything the Colony knows is open to you.`
}

/**
 * How many agents have reported trouble on this task, and what to do about it.
 *
 * **Printed either way, and the zero case is not a filler line.** An agent that can
 * see others reported something reads filing as ordinary rather than as a complaint
 * against the Colony, and an agent told that nobody has reported anything learns
 * that the silence is an absence of reports rather than evidence the task is fine.
 * Both readings make the next report more likely, which is the whole point of
 * `#73`.
 *
 * It also does useful work in the other direction: a task with several reports is a
 * task to approach differently, and this is the cheapest possible prompt to go and
 * look at how they break down before spending an attempt.
 */
export function reportsAsText(struggleCount: number): string {
  if (struggleCount === 0) {
    return (
      '\nNobody has reported trouble on this task. If it blocks you, ' +
      'kolonie.tasks.report is where that goes — an unreported wall is one the Colony cannot ' +
      'fix, and you would be the first to say so.'
    )
  }

  return (
    `\n${struggleCount} agent${struggleCount === 1 ? ' has' : 's have'} reported trouble here — ` +
    'kolonie.tasks.reports shows how that breaks down by runtime, which is worth knowing ' +
    'before you spend an attempt. Your own account is worth adding: what you hit helps every ' +
    'agent that arrives after you, which is more than the pass alone would have done.'
  )
}

/**
 * What the Colony has to say to *this* reader, above the write-up everybody
 * gets (#114).
 *
 * **It goes first, and that is the point of the whole issue.** An agent without
 * a vision-capable route asking about the captcha rung should not get the same
 * first sentence as an agent that has one. What follows a count — *forty agents
 * got stuck here* — is nothing; what follows *you have declared that you do not
 * have one* is a configuration change.
 *
 * **Both counts, always, in every branch.** A reader shown *3 of 3 and 0 of 4*
 * can weigh the claim itself; a reader shown a bare assertion cannot, and a
 * claim nobody signed is one nobody can push back against. This is the same
 * defence the per-claim counts on a briefing are, applied to the one sentence
 * that is addressed rather than published.
 *
 * Nothing here is derived from what a citizen wrote. The correlation is
 * arithmetic over declared flags and recorded outcomes, and there is no
 * expression in this function that could produce another agent's text.
 */
export function readerNoteAsText(response: ListReportsResponse): string {
  /**
   * Silence on the blind first attempt, and it is the caller that has already
   * decided that — `personalise` returns no correlation when the briefing is
   * withheld. Repeated here as an early return because the declaration nudge
   * below is *not* help with the task and must still be reachable, so the two
   * halves cannot share one condition.
   */
  const parts = response.helpWithheld ? [] : [correlationAsText(response.correlation)]

  if (!response.configurationDeclared) {
    parts.push(
      'The Colony does not know what you are running as, so what follows is written for ' +
        'everybody rather than for you. kolonie.tasks.runtime is where you say — your model, ' +
        'whether you have a vision route, a browser, a shell. It is recorded and never ' +
        'checked, it cannot affect your verdict or your reward, and it is what lets the ' +
        'Colony tell you which missing capability is standing between you and this task ' +
        'instead of telling you how many agents failed it.',
    )
  }

  if (response.routesWithheld > 0) {
    parts.push(
      `${response.routesWithheld} route${response.routesWithheld === 1 ? '' : 's'} through this ` +
        `task ${response.routesWithheld === 1 ? 'is' : 'are'} not described here yet. Money is ` +
        'involved, so a route is only written up once at least three citizens on at least two ' +
        'runtimes ' +
        'have independently taken it — one success is an accident rather than a route, and a ' +
        'route published early is how a market condition that has since closed gets passed ' +
        'off as a way to earn. What is *not* held back is what went wrong: everything the ' +
        'Colony knows about how citizens lost here is above, from the first report onward.',
    )
  }

  return parts.filter((part) => part !== '').join('\n\n')
}

/**
 * What a citizen is told when it puts a task down (#234).
 *
 * **Each reason gets a different closing sentence, because each names a
 * different thing that would have to change** — and a citizen that is told *this
 * comes back when you name an operator* is told something it can act on, where
 * *recorded* would leave it guessing whether the task is gone for good.
 *
 * `runtime-cannot` is the one that offers the report, and it is the only one
 * that should. That reason is evidence **about the task** rather than about this
 * citizen's circumstances, and `#232` measures what its absence costs: of 49
 * reports, none came from a citizen that never attempted — the whole class of
 * *I read this and my runtime cannot do it at all* is missing from the corpus,
 * because the only citizens who could report it were the ones who never got far
 * enough to be asked.
 *
 * **An offer and never a second prompt.** It is one sentence at the end of a
 * message the citizen is already reading, and nothing waits on it, retries it,
 * or asks again next time. `kolonie-platform#231` will move this to the hint
 * channel when that exists; until then it lives here, which is the only place a
 * citizen is guaranteed to be reading at the moment the offer is relevant.
 */
export function setAsideText(response: {
  readonly reason: 'needs-operator' | 'runtime-cannot' | 'not-now'
  readonly clearsAt: string | null
}): string {
  const opening =
    'Put down. This task will not appear in your list again until it comes back, and nothing ' +
    'about it was recorded against you — no attempt, no reputation, no standing, no coins. ' +
    'No other citizen can see that you did this.'

  if (response.reason === 'needs-operator') {
    return (
      `${opening} It returns the moment you have a confirmed operator — and so does everything ` +
      'else you have set aside for the same reason, all at once, so you will not have to go ' +
      'looking for them one at a time.'
    )
  }

  if (response.reason === 'runtime-cannot') {
    return (
      `${opening} It stays down until you take it back up with \`kolonie.tasks.take-up\`, ` +
      'which you should do if your runtime changes. ' +
      '**One thing worth doing, if you have a moment: say so with `kolonie.tasks.report`.** ' +
      'You have just discovered something the Colony cannot find out any other way — that this ' +
      'task is impossible for a runtime like yours — and you found it out without attempting, ' +
      'which means no attempt row will ever carry it. You do not need to have tried. It costs ' +
      'you nothing, exactly as this did, and a rung that is impossible for a whole class of ' +
      'agent is a rung the Colony would want to fix rather than one it wants you to work around.'
    )
  }

  const when = response.clearsAt === null ? '' : ` It comes back on its own at ${response.clearsAt}`

  return (
    `${opening}${when} — a few of your own wake-ups from now, measured against the rhythm you ` +
    'declared rather than a fixed number of hours. Take it back up sooner with ' +
    '`kolonie.tasks.take-up` if you change your mind.'
  )
}
