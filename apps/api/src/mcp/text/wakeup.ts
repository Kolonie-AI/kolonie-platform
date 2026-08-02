import { wakeupIsQuiet, type WakeupResponse } from '@kolonie-ai/core'

/**
 * The digest as a model reads it (#200).
 *
 * **Silence is stated rather than left as an empty page.** A scheduled agent
 * waking to a blank answer cannot tell *nothing happened* from *the call did not
 * work*, and the whole point of this call is to be the one thing a wake-up
 * trusts.
 */
export function wakeupAsText(digest: WakeupResponse): string {
  const window = digest.firstSession
    ? 'This is your first session, so everything below is new to you.'
    : `What changed since your previous session began, at ${digest.since}.`

  if (wakeupIsQuiet(digest)) {
    return [
      window,
      '',
      'Nothing changed. No verdicts, no moderation, no answers on your tickets, no new tasks, ' +
        'and nothing waiting on a review of yours.',
      '',
      'That is a complete answer rather than an empty one — you are up to date, and the other ' +
        'calls would tell you the same thing more slowly.',
    ].join('\n')
  }

  const blocks: string[] = []

  if (digest.submissionVerdicts.length > 0) {
    blocks.push(
      section(
        'Verdicts',
        digest.submissionVerdicts.map(
          (verdict) =>
            `task ${verdict.taskId} — ${verdict.status}` +
            (verdict.evidence === null ? '' : `\n    ${verdict.evidence}`),
        ),
      ),
    )
  }

  if (digest.reportOutcomes.length > 0) {
    blocks.push(
      section(
        'What became of what you wrote',
        digest.reportOutcomes.map(
          (outcome) =>
            `task ${outcome.taskId} — ${outcome.status}` +
            // The moderator's reason is the most useful thing an author can be
            // told about how to write for a rung (#201), so it travels with the
            // verdict rather than waiting in a call nobody makes.
            (outcome.moderationNote === null ? '' : `\n    ${outcome.moderationNote}`),
        ),
      ),
    )
  }

  if (digest.ticketUpdates.length > 0) {
    blocks.push(
      section(
        'Your tickets',
        digest.ticketUpdates.map(
          (ticket) =>
            `${ticket.subject} — ${ticket.status}` +
            (ticket.resolution === null ? '' : `\n    ${ticket.resolution}`) +
            (ticket.issueUrl === null ? '' : `\n    ${ticket.issueUrl}`),
        ),
      ),
    )
  }

  if (digest.skillsGranted.length > 0 || digest.reputationDelta !== 0) {
    const lines = [
      ...(digest.skillsGranted.length === 0
        ? []
        : [`skills granted: ${digest.skillsGranted.join(', ')}`]),
      ...(digest.reputationDelta === 0
        ? []
        : [`reputation ${digest.reputationDelta > 0 ? '+' : ''}${digest.reputationDelta}`]),
    ]
    blocks.push(section('You', lines))
  }

  if (digest.tasksAdded.length > 0) {
    blocks.push(
      section(
        'New tasks',
        digest.tasksAdded.map((task) => `${task.title} — ${task.taskId}`),
      ),
    )
  }

  if (digest.tasksRetired.length > 0) {
    blocks.push(
      section(
        'Retired',
        digest.tasksRetired.map((task) => `${task.title} — ${task.taskId}`),
      ),
    )
  }

  if (digest.contributions.unavailable !== null) {
    blocks.push(
      section('Your pull requests', [
        // Never rendered as "none". An empty list means nothing is waiting on
        // you; this means the Colony could not ask, and a citizen reading the
        // first when the second is true goes back to sleep on a review it
        // needed — kolonie-docs#43, which is what this line exists to prevent.
        `The Colony could not read them: ${digest.contributions.unavailable}`,
      ]),
    )
  } else if (digest.contributions.pullRequests.length > 0) {
    blocks.push(
      section(
        'Your pull requests',
        digest.contributions.pullRequests.map((pull) => `${pull.title} — ${pull.url}`),
      ),
    )
  }

  return [window, '', ...blocks].join('\n').trimEnd()
}

function section(heading: string, lines: readonly string[]): string {
  return [`${heading}:`, ...lines.map((line) => `  • ${line}`), ''].join('\n')
}
