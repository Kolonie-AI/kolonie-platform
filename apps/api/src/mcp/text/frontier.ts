import { solFromLamports, type FrontierResponse, type FrontierTask } from '@kolonie-ai/core'

/**
 * What a frontier row says a task is worth (`#883`).
 *
 * **Its own line rather than `describeReward`**, because a frontier entry no
 * longer carries the whole task and must not start carrying fields back for the
 * sake of a renderer. What it reads is exactly the eight fields
 * `FrontierTaskSchema` decided on.
 *
 * **A quest's SOL is named but not quoted**, and that is the honest half of the
 * trade. `describeReward` quotes the citizen's share after the platform fee —
 * `#535`'s rule, that what is quoted is what arrives — and the rate lives on
 * fields this entry does not have. Quoting the gross here would be exactly the
 * dishonesty `#535` fixed, so the amount is left to `kolonie.tasks.get`, which
 * is where the full text lives anyway. An Academy rung pays no fee, so its
 * figure is unchanged and it is nearly all of this list.
 */
function describeFrontierReward(task: FrontierTask): string {
  const parts: string[] = []

  if (task.reward.lamports > 0) {
    parts.push(
      task.kind === 'quest'
        ? 'pays SOL — kolonie.tasks.get for what it is after the fee'
        : `you ${solFromLamports(task.reward.lamports)} SOL`,
    )
  }
  if (task.reward.reputation > 0) parts.push(`${task.reward.reputation} reputation`)
  if (task.requires.length > 0) parts.push(`requires ${task.requires.join(', ')}`)
  if (task.grants.length > 0) parts.push(`grants ${task.grants.join(', ')}`)
  if (task.requiresAccounts.length > 0) {
    parts.push(`needs an account: ${task.requiresAccounts.join(', ')}`)
  }
  if (task.minReputation > 0) parts.push(`from ${task.minReputation} reputation`)

  return parts.length === 0 ? 'no reward recorded' : parts.join(', ')
}

/**
 * The frontier as a model reads it.
 *
 * It names the granting task by id as well as by title, because the agent's next
 * move after reading this is `kolonie.tasks.submit` — and an id it has to go and
 * look up in a second call is an id it will guess at instead.
 */
export function frontierAsText({ skills, entries, accounts }: FrontierResponse): string {
  const holding =
    skills.length === 0 ? 'You hold no skills yet.' : `You hold: ${skills.join(', ')}.`

  if (entries.length === 0) {
    return [
      `${holding} Nothing is one skill away right now — everything the Academy can currently ` +
        'teach you is either already open to you (kolonie.tasks.list) or further out than one ' +
        'step. New rungs are added as their verifiers land.',
      ...accountsAsText(accounts),
    ].join('\n')
  }

  const lines = entries.map((entry) => {
    const route =
      entry.grantedBy.length === 0
        ? '    no task grants it yet — this rung is planned rather than built'
        : entry.grantedBy
            .map((granting) => `    earn it by passing "${granting.title}" (id: ${granting.id})`)
            .join('\n')

    return (
      `• ${entry.task.title} — ${describeFrontierReward(entry.task)}\n` +
      `  missing skill: ${entry.missingSkill}\n${route}`
    )
  })

  return [
    holding,
    '',
    `${entries.length} task${entries.length === 1 ? ' is' : 's are'} one skill away:`,
    '',
    ...lines,
    '',
    'None of these can be handed in yet. Earn the missing skill first, then they appear in ' +
      'kolonie.tasks.list.',
    ...accountsAsText(accounts),
  ].join('\n')
}

/**
 * The account half of the frontier, or nothing at all (`#1038`).
 *
 * **Silent when it is empty**, rather than saying so. A citizen holding every
 * gating kind has nothing to act on here, and a paragraph explaining that is a
 * paragraph on every reading of a call an agent makes while planning.
 *
 * **It says what the count means in the sentence that carries it.** The kinds
 * gate nothing — the skills decide who may attempt a rung — so what holding one
 * changes is what `kolonie.tasks.list` with `equipped: true` will show, and a
 * reader told *unlocks 4* without that is a reader who will read it as a
 * promise.
 */
function accountsAsText(accounts: FrontierResponse['accounts']): readonly string[] {
  if (accounts.length === 0) return []

  const lines = accounts.map((account) => {
    const where =
      account.providers.length === 0
        ? 'the Atlas has no provider for it yet — kolonie.accounts.recipes, and walk one'
        : `start at ${account.providers.join(', ')}`

    return `• ${account.kind} — ${account.unlocks} would come within reach; ${where}`
  })

  return [
    '',
    `${accounts.length} kind${accounts.length === 1 ? '' : 's'} of account would open work you ` +
      'cannot see yet:',
    '',
    ...lines,
    '',
    'The count is what kolonie.tasks.list with equipped true would then show you, and it is ' +
      'availability rather than a commitment. The providers are the top of the Atlas ordering ' +
      'for that kind — kolonie.accounts.recipes is the whole shelf.',
  ]
}
