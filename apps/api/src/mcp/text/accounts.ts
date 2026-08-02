import type { Account } from '@kolonie-ai/core'

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
