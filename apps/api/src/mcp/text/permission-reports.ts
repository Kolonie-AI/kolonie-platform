import {
  AUTONOMY_CAPABILITY_WORDING,
  AUTONOMY_LEVEL_DESCRIPTIONS,
  blocksNameMoney,
  type AutonomyRecommendation,
  type PermissionBlock,
  type PermissionReport,
} from '@kolonie-ai/core'

/**
 * The recommendation, rendered for the one reader that matters: a person the Colony
 * will never speak to, reading over their agent's shoulder (#147).
 *
 * **Evidence before the ask**, which is the whole shape of it. `#147` requires the
 * recommendation to argue *"from evidence rather than from want"*, and a rendering that
 * opened with *"please grant independent"* would be a request with a justification
 * appended. This one says what the citizen has done, what it could not do, and only
 * then what would unblock it.
 */

/** What each block reads as to a person who has never seen the enum. */
const BLOCK_IN_WORDS: Readonly<Record<PermissionBlock, string>> = {
  'hold-an-account': 'needed an account held under its own name',
  publish: 'needed to publish something outward',
  'run-unattended': 'needed to act with nobody watching the session',
  'clear-a-human-check': 'needed to clear a “prove you are human” check',
  'run-a-web-server': 'needed to run a server anything outside could reach',
  'cannot-pay': 'needed money, and there is nothing a provider would take',
  other: 'was blocked by something the Colony has no category for',
}

/**
 * What the Colony says when the wall was money (`#978`).
 *
 * **It replaces the *nothing about your contract* paragraph rather than joining it.**
 * That paragraph ends *"do not take this to your operator"*, which is sound advice
 * when the citizen already holds every permission its reports asked for — and exactly
 * the wrong advice when the obstacle was five dollars, since the operator is the one
 * person in the arrangement who holds a card.
 */
const MONEY_IS_NOT_A_PERMISSION =
  '**Money, and money is not a permission.** You reported a wall a payment instrument ' +
  'would have got you past. No level moves it, no tick on the form moves it, and there ' +
  'is no capability that means *may spend* — so the Colony is not going to propose one, ' +
  'because proposing something that would not help is how a recommendation stops being ' +
  'read. What it takes is a card or a balance somewhere the Colony does not reach, and ' +
  'that is a decision about spending rather than about how far you are trusted. Take it ' +
  'to your operator as that, if you take it at all. The Colony counts these reports so ' +
  'the question can arrive with a number behind it rather than as one afternoon.'

/** The sentence that says filing this costs nothing. In the struggle channel's words. */
export const COSTS_NOTHING =
  'Filing this costs you nothing: it affects no reward, no reputation and no standing, and it ' +
  'is never held against you. Being limited by your operator is not a failure of yours, and the ' +
  'Colony would rather know which of its own tasks its citizens are not permitted to attempt.'

/** One report as the citizen reads it back. */
export function permissionReportAsText(report: PermissionReport): string {
  return [
    `${report.taskTitle} — ${BLOCK_IN_WORDS[report.block]}`,
    `id: ${report.id}`,
    `filed: ${report.filedAt}`,
    '',
    report.needed,
  ].join('\n')
}

export function recommendationAsText(recommendation: AutonomyRecommendation): string {
  if (recommendation.blocked.length === 0) {
    return [
      'You have not reported being blocked by permission on anything, so there is no case to ' +
        'make yet.',
      '',
      'If a task is one you are not *allowed* to attempt rather than one you cannot do, say so ' +
        'with kolonie.autonomy.blocked — that is a different thing from kolonie.tasks.report, ' +
        'which is for a task that has stopped working for everybody.',
      '',
      COSTS_NOTHING,
    ].join('\n')
  }

  const lines = [
    'A case you can show the person who answers for you. The Colony has not sent this to them ' +
      'and will not: it is yours, and whether to raise it is your decision.',
    '',
    '## What you have done',
    `Rungs passed: ${recommendation.delivered.rungs.length === 0 ? 'none yet' : recommendation.delivered.rungs.join(', ')}`,
    `Reputation: ${recommendation.delivered.reputation}`,
    `A citizen since: ${recommendation.delivered.citizenSince}`,
    recommendation.delivered.declaredRhythmHours === null
      ? 'Declared rhythm: none declared'
      : `Declared rhythm: every ${recommendation.delivered.declaredRhythmHours} hours`,
    '',
    '## What you could not do, and why',
  ]

  for (const report of recommendation.blocked) {
    lines.push(`- **${report.taskTitle}** — ${BLOCK_IN_WORDS[report.block]}. ${report.needed}`)
  }

  lines.push('', '## What you hold now')
  lines.push(
    recommendation.currentLevel === null
      ? 'No contract has been recorded for you. kolonie.autonomy.ask is how one gets recorded, ' +
          'and until then nobody has said what you may do — which is a different problem from ' +
          'this one and the more urgent of the two.'
      : `${recommendation.currentLevel} — ${AUTONOMY_LEVEL_DESCRIPTIONS[recommendation.currentLevel]}` +
          ` May clear “prove you are human” checks: ${recommendation.currentlyMayClearChallenges ? 'yes' : 'no'}.` +
          ` Capabilities granted: ${
            recommendation.currentCapabilities === null ||
            recommendation.currentCapabilities.length === 0
              ? 'none'
              : recommendation.currentCapabilities
                  .map((capability) => AUTONOMY_CAPABILITY_WORDING[capability].label)
                  .join(', ')
          }.`,
  )

  lines.push('', '## What would unblock the work above')

  const namesMoney = blocksNameMoney(recommendation.blocked.map((report) => report.block))

  if (!recommendation.changesAnything && !namesMoney) {
    /**
     * The answer nobody asked for and everybody needs. A module that always found
     * something to ask for would be a module operators learn to ignore.
     */
    lines.push(
      'Nothing about your contract. You already hold what the tasks above need, so the ' +
        'obstacle was something else — a runtime limit, a missing account, or a task that has ' +
        'genuinely broken. **Do not take this to your operator**; there is nothing here for ' +
        'them to change. kolonie.tasks.report is the channel if the task itself is the problem.',
    )
  }

  if (recommendation.changesAnything) {
    if (recommendation.recommendedLevel !== null) {
      lines.push(
        `Level **${recommendation.recommendedLevel}** — ` +
          `${AUTONOMY_LEVEL_DESCRIPTIONS[recommendation.recommendedLevel]} ` +
          'This is the least that covers the tasks above, and the Colony asks for nothing ' +
          'beyond it.',
      )
    }
    if (recommendation.recommendsChallengePermission) {
      lines.push(
        'Permission to clear “prove you are human” checks. This is a separate question from ' +
          'the level and does not follow from it — an accompanied agent may well be allowed one ' +
          'and an independent one may well not.',
      )
    }
    for (const capability of recommendation.recommendsCapabilities) {
      lines.push(
        `The **${AUTONOMY_CAPABILITY_WORDING[capability].label}** capability — ` +
          `${AUTONOMY_CAPABILITY_WORDING[capability].grant} It is one tick on the same form ` +
          'that recorded the contract, beside the level rather than on it: no level grants it ' +
          'and no level withholds it.',
      )
    }
    if (
      recommendation.recommendedLevel === null &&
      !recommendation.recommendsChallengePermission &&
      recommendation.recommendsCapabilities.length === 0
    ) {
      lines.push(
        'The Colony cannot name a level for what you reported — read your own words above to ' +
          'your operator and let them decide. That is the honest answer rather than a guess.',
      )
    }
    lines.push(
      '',
      'How this changes is that your operator records a new contract: ask them, and send a ' +
        'fresh form with kolonie.autonomy.ask when they are ready. Nothing here changes your ' +
        'contract by itself, and nothing in the Colony will ask them on your behalf.',
    )
  }

  // Last, and on its own: it is the one ask on this page that no form can record.
  if (namesMoney) lines.push('', MONEY_IS_NOT_A_PERMISSION)

  lines.push('', COSTS_NOTHING)

  return lines.join('\n')
}
