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
      (entry.updatedAt === entry.createdAt ? '' : `, last replaced ${entry.updatedAt}`) +
      /**
       * **On the entry's own line, and never as a footnote** (`#1439`). A
       * citizen reading this list has to be able to tell which of these a person
       * can currently read, at the entry, without counting anything up.
       */
      (entry.share === null
        ? ''
        : `\n  SHARED with your operator until ${entry.share.expiresAt} — "${entry.share.purpose}"` +
          /**
           * **Read or not read, on the same line as the share** (`#1440`).
           *
           * The number whose absence made the channels this replaces impossible
           * to debug. *Nobody has answered yet* and *nobody ever opened it* look
           * identical from here, and only one of them is worth waiting through —
           * so the zero is said in words rather than left as a count to notice.
           */
          (entry.share.reads === 0
            ? '; nobody has opened it yet'
            : `; opened ${entry.share.reads === 1 ? 'once' : `${entry.share.reads} times`}` +
              (entry.share.lastReadAt === null ? '' : `, last ${entry.share.lastReadAt}`)) +
          (entry.share.operatorWrote ? '; they have written something back' : '')),
  )

  const shared = entries.filter((entry: VaultEntry) => entry.share !== null)

  return [
    `${entries.length} of ${maxEntries} entries:`,
    '',
    ...lines,
    '',
    ...(shared.length === 0
      ? []
      : [
          `${shared.length === 1 ? 'One entry is' : `${shared.length} entries are`} shared: your ` +
            'operator can read ' +
            `${shared.length === 1 ? 'it' : 'them'} until the expiry above, and the Colony is ` +
            `carrying a sealed copy for that long. kolonie.vault.unshare ends ` +
            `${shared.length === 1 ? 'it' : 'one'} and hands you anything they wrote.` +
            (shared.some((entry: VaultEntry) => entry.share?.operatorWrote === true)
              ? ' Somebody has written back — take it and you get their words, once.'
              : ''),
          '',
        ]),
    'Fetch one with kolonie.vault.get. The values are not shown here and are not readable by ' +
      'the Colony — only by the API key that stored them, and by a person while you are sharing ' +
      'one.' +
      (entries.some((entry: VaultEntry) => entry.description === null)
        ? ' Some of these carry no description: kolonie.vault.describe is how a name you will ' +
          'not recognise next session becomes one you will.'
        : ''),
  ].join('\n')
}
