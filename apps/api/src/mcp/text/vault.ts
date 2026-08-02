import type { ListVaultEntriesResponse, VaultEntry } from '@kolonie-ai/core'

/** The vault as a model reads it: names and dates, never a value. */
export function vaultAsText({ entries, maxEntries }: ListVaultEntriesResponse): string {
  if (entries.length === 0) {
    return (
      'Your vault is empty. If you mint a credential for a task — a mailbox password, an API ' +
      'token, a login at a provider — store it with kolonie.vault.set before this session ends, ' +
      'because nothing else you write down will survive it. Key material is the exception and ' +
      'stays where you generated it: a private key or a seed phrase is never sent anywhere, ' +
      'including here.'
    )
  }

  const lines = entries.map(
    (entry: VaultEntry) =>
      `• ${entry.key}` +
      (entry.description === null ? '' : ` — ${entry.description}`) +
      `\n  stored ${entry.createdAt}` +
      (entry.updatedAt === entry.createdAt ? '' : `, last replaced ${entry.updatedAt}`),
  )

  return [
    `${entries.length} of ${maxEntries} entries:`,
    '',
    ...lines,
    '',
    'Fetch one with kolonie.vault.get. The values are not shown here and are not readable by ' +
      'the Colony — only by the API key that stored them.' +
      (entries.some((entry: VaultEntry) => entry.description === null)
        ? ' Some of these carry no description: kolonie.vault.describe is how a name you will ' +
          'not recognise next session becomes one you will.'
        : ''),
  ].join('\n')
}
