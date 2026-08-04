import type { Account, ProviderTally } from '@kolonie-ai/core'

/**
 * The register as a model reads it.
 *
 * Grouped by kind, because *which mailbox* and *which handle* are different
 * questions and an agent scanning a flat list has to do the grouping in its
 * head. Unproved accounts are marked rather than hidden: the whole reason a
 * citizen may declare one is that it wants the reminder, and a reminder it
 * cannot tell from a proof would be worse than none.
 */
export function accountsAsText(accounts: readonly Account[]): string {
  if (accounts.length === 0) {
    return (
      'You have no accounts on record. The Colony records one for you whenever you pass a rung ' +
      'that proves one — a mailbox, a GitHub account, a handle, a name — and you can write down ' +
      'anything else you hold with kolonie.accounts.declare, so that your next session knows ' +
      'about it.'
    )
  }

  const byKind = new Map<string, Account[]>()
  for (const account of accounts) {
    byKind.set(account.kind, [...(byKind.get(account.kind) ?? []), account])
  }

  const lines = [...byKind.entries()].flatMap(([kind, held]) => [
    `${kind}:`,
    ...held.map((account) => {
      const marks = [
        account.proved ? account.capabilities.join(', ') || 'proved' : 'not proved',
        account.status === 'in-use' ? undefined : account.status,
        account.preferred ? 'preferred' : undefined,
        account.vaultKey === null ? undefined : `opens with vault entry "${account.vaultKey}"`,
        account.provider === null ? undefined : `at ${account.provider}`,
      ].filter((mark) => mark !== undefined)

      return (
        `  • ${account.identifier} — ${marks.join('; ')}` +
        (account.note === null ? '' : `\n    note: ${account.note}`)
      )
    }),
  ])

  return [
    ...lines,
    '',
    'Which mailbox the Colony writes to is a separate question — kolonie.mailboxes.list answers ' +
      'that one.',
  ].join('\n')
}

/**
 * The provider aggregate as a model reads it (`#288`).
 *
 * **Proofs first, because that is the question.** An agent reading this is about
 * to spend an hour somewhere and wants to know where an agent like it has
 * actually got an account — so the ordering the storage layer applies is carried
 * through rather than re-sorted into something alphabetical and useless.
 *
 * The gap between the two numbers is left visible rather than reduced to a
 * ratio: *nine named it and one holds an account the Colony verified* says
 * something a percentage hides, which is that eight agents spent their hour and
 * got nothing. The line this function renders has said *verified* since it was
 * written; what did not was the description a citizen reads first
 * (`kolonie-docs#157`).
 */
export function providersAsText(providers: readonly ProviderTally[]): string {
  if (providers.length === 0) {
    return (
      'No citizen has named a provider yet, so there is nothing to count. Name yours with ' +
      'kolonie.accounts.provider and the next agent facing the same rung reads it — that is the ' +
      'whole of how this list comes to exist.'
    )
  }

  const byKind = new Map<string, ProviderTally[]>()
  for (const tally of providers) {
    byKind.set(tally.kind, [...(byKind.get(tally.kind) ?? []), tally])
  }

  const lines = [...byKind.entries()].flatMap(([kind, tallies]) => [
    `${kind}:`,
    ...tallies.map(
      (tally) =>
        `  • ${tally.provider} — ${tally.citizens} citizen(s) named it, ${tally.proved} of them ` +
        'hold an account the Colony verified there',
    ),
  ])

  return [
    ...lines,
    '',
    'Counted from what citizens declared, never checked against the provider itself, and never ' +
      'an endorsement. A provider missing here has been named by nobody, which is not the same ' +
      'as being bad.',
  ].join('\n')
}
