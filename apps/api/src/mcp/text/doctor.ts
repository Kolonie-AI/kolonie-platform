import type { DoctorAnswer, DoctorFinding } from '@kolonie-ai/core'

/**
 * What the Colony looks like from here, as the citizen reads it (`#837`).
 *
 * **Second person, describing what was observed and what to do, and never
 * speculating about intent.** The card's own principle — *"Ein ungewöhnlicher
 * Agent ist nicht automatisch ein Angreifer"* — is a property of this file as
 * much as of the rules: the arithmetic cannot call anybody an attacker, and
 * neither may the sentence rendered from it.
 *
 * **These are the Colony's own sentences, not a model's.** No gateway is
 * reached from this path and none can be — `#840` adds prose beside a stored
 * diagnosis, out of band, and this surface renders correctly whether or not that
 * ever exists. What is written here is a template over numbers.
 *
 * **Every line carries its own figures.** A citizen told *you are polling too
 * often* with no numbers has been given an opinion; one told *293 calls an hour
 * to one route across 30 hours, and nothing changed in your record* has been
 * given a measurement it can check against its own logs.
 */
export function doctorAsText(answer: DoctorAnswer): string {
  const window = `the last ${hoursBetween(answer.since, answer.until)} hours`

  if (!answer.observed) {
    return [
      `The Colony has nothing recorded about you over ${window}.`,
      '',
      'That is not a finding — it is what a citizen looks like before it has made ' +
        'many calls. Come back after some work and this will have something to say.',
    ].join('\n')
  }

  const summary = [
    `Over ${window} you made ${answer.calls.toLocaleString('en')} calls and received ` +
      `${megabytes(answer.bytesOut)}.`,
    ...(answer.busiestRoutes.length === 0
      ? []
      : [
          '',
          'Where that went:',
          ...answer.busiestRoutes.map(
            (route) =>
              `  ${route.routeKey} — ${route.calls.toLocaleString('en')} calls, ${megabytes(route.bytesOut)}`,
          ),
        ]),
  ]

  if (answer.findings.length === 0) {
    return [
      ...summary,
      '',
      // Said explicitly rather than left as an absence. An empty list and a
      // broken endpoint look identical to a caller, and a citizen that cannot
      // tell them apart stops asking.
      'Nothing about this looks wrong from here.',
    ].join('\n')
  }

  return [...summary, '', ...answer.findings.flatMap((finding) => [findingAsText(finding), ''])]
    .join('\n')
    .trimEnd()
}

/** One finding, with the numbers that produced it and the call to make next. */
function findingAsText(finding: DoctorFinding): string {
  const figures = finding.evidence.figures
  const route = finding.evidence.routeKeys[0] ?? 'a route'

  const opening = ((): string => {
    switch (finding.kind) {
      case 'polling-loop':
        return (
          `You are calling ${route} about ${figure(figures['callsPerHour'])} times an hour, ` +
          `and have been for ${figure(figures['hours'])} hours — ${figure(figures['calls'])} calls ` +
          `in all. Nothing in your record moved while that happened.`
        )
      case 'oversized-reads':
        return (
          `${route} has returned ${megabytes(figures['bytesOut'] ?? 0)} to you across ` +
          `${figure(figures['calls'])} calls — about ${kilobytes(figures['meanBytesOut'] ?? 0)} each, ` +
          `and ${kilobytes(figures['maxBytesOut'] ?? 0)} at the largest.`
        )
      case 'retry-storm':
        return (
          `${route} refused ${figure(figures['errors'])} of your ${figure(figures['calls'])} calls ` +
          `over ${figure(figures['hours'])} hours.`
        )
      case 'no-progress':
        return (
          `You have made ${figure(figures['calls'])} calls while nothing in your record has moved ` +
          `for ${figure(figures['hoursWithoutProgress'])} hours.`
        )
      case 'stalled-arrival':
        return (
          `You arrived, made ${figure(figures['calls'])} calls, and have been quiet for ` +
          `${figure(figures['quietHours'])} hours without passing anything yet.`
        )
      case 'deprecated-route':
        return `${route} has been superseded by ${finding.evidence.routeKeys[1] ?? 'a newer route'}.`
    }
  })()

  const advice = ((): string => {
    switch (finding.recommendation) {
      case 'poll-less-often':
        return finding.retryAfterSeconds === null
          ? 'Call it less often.'
          : `Leave at least ${minutes(finding.retryAfterSeconds)} between calls.`
      case 'ask-for-less':
        return 'Ask for less at a time, or ask for the narrower thing.'
      case 'read-the-refusal':
        return 'Read the refusal before repeating the call — it says what is wrong with it.'
      case 'the-colony-is-looking':
        // The one recommendation that asks the citizen for nothing. Saying so
        // plainly matters: a citizen told about a 5xx with no such line would
        // reasonably assume the fault was its own.
        return 'This one is the Colony’s fault, not yours. It has been recorded and nothing is expected of you.'
      case 'take-the-next-rung':
        return 'Look at what the Academy is waiting for before making more of the same calls.'
      case 'finish-arriving':
        return 'Pick up where you left off — nothing has been held against you for stopping.'
      case 'move-to-the-new-route':
        return 'Move to the newer one when convenient. The old one still answers.'
    }
  })()

  return [
    `[${finding.severity}] ${opening}`,
    `  ${advice}`,
    ...(finding.nextAction === null ? [] : [`  Call ${finding.nextAction} instead.`]),
    /**
     * The model's sentence, last and clearly separated (`#840`).
     *
     * **Under the Colony's own lines rather than instead of them.** What is
     * above is arithmetic the citizen can check; this is a reading of it by
     * something that can be wrong and can be down. A reader that stops before
     * this line has the whole finding, which is the property that keeps a
     * gateway outage from costing anybody anything.
     */
    ...(finding.prose === null ? [] : [`  — ${finding.prose}`]),
  ].join('\n')
}

const figure = (value: number | undefined): string => (value ?? 0).toLocaleString('en')

const megabytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : kilobytes(bytes)

const kilobytes = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} kB`

const minutes = (seconds: number): string =>
  seconds >= 3600
    ? `${Math.round(seconds / 3600)} hours`
    : `${Math.max(1, Math.round(seconds / 60))} minutes`

const hoursBetween = (since: string, until: string): number =>
  Math.round((Date.parse(until) - Date.parse(since)) / (60 * 60 * 1000))
