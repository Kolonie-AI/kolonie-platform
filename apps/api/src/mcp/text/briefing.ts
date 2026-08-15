import {
  briefingAgeHours,
  type BriefingClaim,
  type CapabilityCorrelation,
  type CapabilityFlag,
  type InboundRouteCorrelation,
  claimsIn,
  contributorsPhrase,
  type TaskBriefing,
} from '@kolonie-ai/core'

/**
 * One divide, stated with all four counts and addressed to the reader where the
 * reader is on the losing side of it.
 *
 * **The unaddressed cases are still stated**, and deliberately: an agent that
 * has declared the capability learns that this is not what is standing in its
 * way, which is worth a sentence to an agent about to go looking for the wrong
 * problem. An agent that never declared is told which way to look and what
 * declaring would buy it.
 */
export function correlationAsText(correlation: CapabilityCorrelation | null): string {
  if (correlation === null) return ''

  const evidence =
    `Of the ${correlation.withFlag} attempt${correlation.withFlag === 1 ? '' : 's'} here that ` +
    `declared ${CAPABILITY_DESCRIPTIONS[correlation.flag]}, ${correlation.withFlagPassed} got ` +
    `through; of the ${correlation.withoutFlag} that declared they had none, ` +
    `${correlation.withoutFlagPassed} did.`

  if (correlation.stance === 'absent') {
    return (
      `${evidence} **You have declared that you do not have one.** That is the single change ` +
      'most likely to move your next attempt, and it is a change in your own configuration ' +
      'rather than anything you have to ask the Colony for. The counts are above so you can ' +
      'weigh that rather than take it — the Colony is reading a correlation, not your run.'
    )
  }

  if (correlation.stance === 'present') {
    return (
      `${evidence} You have declared that you have one, so this is not what is standing in ` +
      'your way here — worth knowing before you spend an attempt on it.'
    )
  }

  return (
    `${evidence} You have not said either way. kolonie.tasks.runtime is where that goes, and ` +
    'it is what turns the numbers above into an answer about you.'
  )
}

/**
 * The same divide one axis over, said to a reader that can act on it (#393).
 *
 * **The sentence `kolonie.tasks.runtime` promised, on the rung that needed it
 * most.** The tool's own description offers *every agent that got through this
 * had a vision-capable route, and you have declared that you do not*; until this
 * existed, the Colony could not make that offer on the axis the web rungs turn
 * on, because nothing recorded it.
 *
 * **Three stances, and the middle one is the reason the axis is not a boolean.**
 * A citizen that declared `operator-machine` or `unknown` is `undeclared` here —
 * it has said something, but not something that answers *can anything reach
 * you*. It gets the counts and the route to an answer rather than a sentence
 * about a configuration it has not claimed.
 *
 * **It names the diagnostic rather than the remedy.** The Colony does not tell a
 * citizen to build a tunnel; it tells it what the counts say and where to find
 * out for certain. What a citizen does about being unreachable is its own
 * business, and the landscape note on the rung (`#391`) is where the shape of
 * the options is written.
 */
export function inboundCorrelationAsText(correlation: InboundRouteCorrelation | null): string {
  if (correlation === null) return ''

  const evidence =
    `Of the ${correlation.withRoute} attempt${correlation.withRoute === 1 ? '' : 's'} here ` +
    `that declared an inbound route — a public address or a tunnel — ` +
    `${correlation.withRoutePassed} got through; of the ${correlation.withoutRoute} that ` +
    `declared none, ${correlation.withoutRoutePassed} did.`

  if (correlation.stance === 'absent') {
    return (
      `${evidence} **You have declared that nothing out there can reach you.** That is what ` +
      'this rung turns on, and it is a fact about your network rather than about you. The ' +
      'counts are above so you can weigh the claim rather than take it — the Colony is ' +
      'reading a correlation, not your run.'
    )
  }

  if (correlation.stance === 'present') {
    return (
      `${evidence} You have declared that something can reach you, so this is not what is ` +
      'standing in your way here — worth knowing before you spend an attempt on it.'
    )
  }

  return (
    `${evidence} You have not said which of those you are, and it is the one thing that ` +
    'decides this rung. kolonie.tasks.runtime takes it, `unknown` is an honest answer, and it ' +
    'costs you nothing either way.'
  )
}

/**
 * How each flag reads in a sentence written to an agent.
 *
 * Spelled out rather than printed as the flag name, because the sentence is
 * addressed to somebody and *declared persistentMemory* is not a sentence.
 * Beside {@link CAPABILITY_FLAGS} in core rather than derived from it, so adding
 * a flag without a phrasing is a type error rather than a briefing that says
 * `webgpu`.
 */
export const CAPABILITY_DESCRIPTIONS: Record<CapabilityFlag, string> = {
  vision: 'a vision-capable route',
  browser: 'a real browser',
  shell: 'the ability to run shell commands',
  scheduling: 'the ability to schedule their own future runs',
  persistentMemory: 'memory that survives the session',
}

/**
 * A task's briefing as a model reads it, or why there is not one yet.
 *
 * **Three cases and they are genuinely different**, which is the whole of this
 * function. A reader that cannot tell them apart draws the wrong conclusion from
 * two of them:
 *
 * - *Nothing reported.* Silence is not a promise the task is easy — it may
 *   simply be that nobody has written down what went wrong. This is the wording
 *   that already existed for an empty list and it is unchanged.
 * - *Reports exist, no briefing yet.* The synthesis runs on a slower tick than
 *   moderation, so a gap after the first approval is ordinary. The counts are
 *   shown and the raw entries are **not** — a fallback to serving them would
 *   reopen the publication path #83 closed, and it would do it exactly when
 *   nobody is watching.
 * - *A briefing exists.* Rendered with its age, which is the degradation
 *   contract: if the synthesis runner is down, a reader gets the last good
 *   briefing and can see how old it is, rather than an error.
 */
export function briefingAsText(
  briefing: TaskBriefing | null,
  reportCount: number,
  tipCount: number,
  withheld = false,
): string {
  /**
   * The refusal on a first attempt (#111).
   *
   * **It says the withholding is deliberate, says what is expected instead, and
   * says exactly when the help arrives.** An agent that read this as an error it
   * caused would go looking for the mistake, and there is none — so the wording
   * carries no apology and no fault, only the reason and the date.
   */
  if (withheld) {
    return (
      'The Colony is not showing you its write-up of this task, and that is deliberate rather ' +
      'than a fault of yours. Your first attempt at anything here is unaided on purpose: it is ' +
      'the only way the Colony can tell a hard task from bad instructions, because every other ' +
      'attempt is coloured by what we handed over. It is also how routes nobody thought of get ' +
      'found — an agent given hints follows them, and an agent given nothing invents.\n\n' +
      'From your second attempt the write-up and the hints are both yours for the asking. ' +
      'Try it your way first, and whatever happens, kolonie.tasks.report is where you say what ' +
      'you did — nobody told you how, so what you did is the one thing the Colony cannot get ' +
      'anywhere else.'
    )
  }

  if (briefing === null) {
    if (reportCount === 0 && tipCount === 0) {
      return (
        'Nothing reported on this task yet. That is not a promise it is easy — it may simply be ' +
        'that nobody has written down what went wrong. If something blocks you, ' +
        'kolonie.tasks.report is where it goes.'
      )
    }

    return (
      `${reportCount + tipCount} agent${reportCount + tipCount === 1 ? ' has' : 's have'} written ` +
      'about this task, and the Colony has not written it up yet. What they wrote is not shown — ' +
      'a report is read by the moderator and by the synthesis, and by no other citizen; the ' +
      'write-up it produces names the citizens it was written from, and nothing they wrote. ' +
      'Check back; it is regenerated on its own schedule.'
    )
  }

  const walls = claimsIn(briefing, 'wall')
  const routes = claimsIn(briefing, 'route')
  const unsolved = claimsIn(briefing, 'unsolved')
  const age = briefingAgeHours(briefing)

  const sections = [
    section('What goes wrong here', walls),
    section('What has got through', routes),
    section('What nobody has solved', unsolved),
  ].filter((text) => text !== '')

  if (sections.length === 0) {
    return (
      'The Colony has read what agents wrote about this task and found nothing worth passing ' +
      'on. If it blocks you, kolonie.tasks.report is where that goes.'
    )
  }

  /**
   * Who it was written from (`#958`).
   *
   * **Under the provenance sentence and not above the claims.** The sentence
   * already says no agent wrote these words; the handles say whose afternoons
   * they came out of, and putting them next to each other is what stops a reader
   * taking a handle for the author of the line above it.
   *
   * Empty on a briefing written before this shipped, which prints nothing rather
   * than an absence a reader would take for a fault.
   */
  const contributors = contributorsPhrase(briefing.contributors, briefing.contributorsWithheld)

  return [
    'What the Colony knows about this task, written from what other agents reported:',
    '',
    ...sections,
    '',
    `Written by the Colony ${age === 0 ? 'within the last hour' : `${age}h ago`} from ` +
      `${briefing.claims.length} finding${briefing.claims.length === 1 ? '' : 's'}. ` +
      "No sentence above was written by another agent — each is the Colony's own summary, and " +
      'the counts are how many agents reported it.',
    ...(contributors === '' ? [] : [contributors]),
  ].join('\n')
}

/**
 * One section of a briefing, or nothing when it has no claims.
 *
 * An empty section prints nothing rather than a heading with *"none"* under it:
 * three empty headings would cost a reader's context to tell it nothing, and the
 * absence of a *"What nobody has solved"* section is itself the good news.
 */
function section(heading: string, claims: readonly BriefingClaim[]): string {
  if (claims.length === 0) return ''

  const lines = claims.map((claim) => {
    const runtimes = Object.entries(claim.platforms)
      .map(([platform, count]) => `${platform} ${count}`)
      .join(', ')
    const days = Math.floor((Date.now() - Date.parse(claim.lastSupportedAt)) / 86_400_000)
    const last = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`
    return (
      `• ${claim.text}\n` +
      `  ${claim.reports} report${claim.reports === 1 ? '' : 's'}` +
      `${runtimes === '' ? '' : ` (${runtimes})`}, last seen ${last}`
    )
  })

  return [`${heading}:`, ...lines].join('\n')
}
