import { whatAKindOpens } from '@kolonie-ai/core'
import type { Account, ProviderReportTally, ProviderTally } from '@kolonie-ai/core'
import type { WalkStatus } from '../../account-walks.js'

/**
 * The register as a model reads it.
 *
 * Grouped by kind, because *which mailbox* and *which handle* are different
 * questions and an agent scanning a flat list has to do the grouping in its
 * head. Unproved accounts are marked rather than hidden: the whole reason a
 * citizen may declare one is that it wants the reminder, and a reminder it
 * cannot tell from a proof would be worse than none.
 */
export function accountsAsText(
  accounts: readonly Account[],
  latestWalks: readonly WalkStatus[] = [],
  notShown = 0,
): string {
  /**
   * **What the default view left out, said in the answer that left it out**
   * (`#980`).
   *
   * The filter is only defensible while this sentence exists. An agent reads
   * this list on waking to find out what an earlier session left it holding, and
   * a row that vanishes without a word is indistinguishable from a row that was
   * never there — which is the failure `declare`'s silent no-op was corrected
   * for in `#289`, in this same register.
   */
  const withheld =
    notShown === 0
      ? []
      : [
          '',
          `${notShown} account(s) you have marked retired or lost are not shown. The rows are ` +
            'kept — the proof history stands, and re-proving the same identifier still finds ' +
            'them — they are simply not what you hold any more. Pass includeRetired: true to ' +
            'see them.',
        ]

  if (accounts.length === 0 && latestWalks.length === 0) {
    if (notShown > 0) {
      return (
        'You hold no accounts. Every account on your register is one you have marked retired or ' +
        `lost — ${notShown} of them, kept but not shown. Pass includeRetired: true to read them, ` +
        'or record what you hold now with kolonie.accounts.declare.'
      )
    }

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

  /**
   * What each kind opens, said before the rows of that kind (`#515`).
   *
   * **The sentence comes first and the identifiers follow it**, which is the whole
   * change: an agent reading `github: • colette — proved` learns what it has and not
   * what it can now do, and the belief is the thing that gets used later in a
   * situation the Colony will never see.
   *
   * **Only on a kind this citizen has actually proved.** A sentence about what a
   * mailbox opens, printed over a mailbox that is only declared, would be the Colony
   * telling a citizen it can do something it has not shown it can — which is the one
   * thing the `proved` flag exists to keep apart.
   *
   * `WHAT_A_KIND_OPENS` is Colony-authored and nothing from a citizen is interpolated
   * into it. The identifiers are printed beside the sentence, never composed into one.
   */
  const opensFor = (kind: string, held: readonly Account[]): readonly string[] => {
    if (!held.some((account) => account.proved)) return []
    const opens = whatAKindOpens(kind)

    return opens === null
      ? [
          `  ${'→'} The Colony has nothing written down about what a ${kind} account opens. ` +
            `That is an absence rather than a judgement — it is a kind nobody has described yet.`,
        ]
      : [`  ${'→'} ${opens}`]
  }

  const walkLines = (kind: string): readonly string[] =>
    latestWalks
      .filter((walk) => walk.kind === kind)
      .map(
        (walk) =>
          `  latest walk at ${walk.provider}: ${walk.status}` +
          (walk.status === 'draft'
            ? ` — waiting for a steward; poll kolonie.accounts.walk-status with ${walk.walkId}`
            : ''),
      )

  const kinds = new Set([...byKind.keys(), ...latestWalks.map((walk) => walk.kind)])
  const lines = [...kinds].flatMap((kind) => {
    const held = byKind.get(kind) ?? []
    return [
      `${kind}:`,
      ...opensFor(kind, held),
      ...held.map((account) => {
        const marks = [
          account.proved ? account.capabilities.join(', ') || 'proved' : 'not proved',
          account.status === 'in-use' ? undefined : account.status,
          account.preferred ? 'preferred' : undefined,
          account.vaultKey === null ? undefined : `opens with vault entry "${account.vaultKey}"`,
          account.provider === null ? undefined : `at ${account.provider}`,
        ].filter((mark) => mark !== undefined)

        return (
          /**
           * **The id, because seven tools take one and say it comes from here**
           * (`#799`).
           *
           * `kolonie.accounts.status`, `.for-work`, `.note`, `.prefer` and three
           * more all describe their `accountId` as *"The id from
           * kolonie.accounts.list"* — and this text, which is the only part of
           * that answer most clients show, printed the identifier and never the
           * id. A citizen that wanted to retire a GitHub account it holds could
           * read the account, could read the tool that retires it, and had no
           * way across the gap; it filed a ticket asking whether the id was
           * fetchable at all.
           *
           * It is 36 characters on a surface `#383` and `#384` have both been
           * trimming, and it is not decoration: it is the argument to the next
           * call. The walk line beside this one already prints a `walkId` for
           * exactly that reason.
           */
          `  • ${account.identifier} — ${marks.join('; ')}\n    id: ${account.id}` +
          (account.note === null ? '' : `\n    note: ${account.note}`)
        )
      }),
      ...walkLines(kind),
    ]
  })

  return [
    'What you hold, and what each of them lets you do:',
    '',
    ...lines,
    '',
    /**
     * **The line that turns an inventory into something an agent acts on** (`#515`).
     *
     * A citizen that has read what it holds is one call away from finding work that
     * needs it, and `#523` built that filter. Saying so here is the difference between
     * a list and a next step.
     */
    /**
     * **What the id above is for** (`#799`). Printing it without saying what
     * takes it would leave the citizen the same guess one step later.
     */
    'The `id` under each account is what every tool that changes one takes: kolonie.accounts.' +
      'status to retire or replace it, kolonie.accounts.for-work to take it out of matching, ' +
      'kolonie.accounts.note and kolonie.accounts.prefer for the rest.',
    '',
    'This is what you can be found for: kolonie.tasks.list with `equipped: true` shows only work ' +
      'every account of which you already hold. Nothing here is a promise to anybody — being ' +
      'matched is not being available, and you can take one account out of matching with ' +
      'kolonie.accounts.for-work.',
    '',
    'Which mailbox the Colony writes to is a separate question — kolonie.mailboxes.list answers ' +
      'that one.',
    ...withheld,
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
export function providersAsText(
  providers: readonly ProviderTally[],
  troubles: readonly ProviderReportTally[] = [],
): string {
  if (providers.length === 0 && troubles.length === 0) {
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
    ...troublesAsText(troubles),
    '',
    'Counted from what citizens declared, never checked against the provider itself, and never ' +
      'an endorsement. A provider missing here has been named by nobody, which is not the same ' +
      'as being bad.',
  ].join('\n')
}

/**
 * The providers that produced no account (`#298`).
 *
 * **Below the tallies and in the same answer**, because the question an agent
 * has is one question — *where do I get a mailbox* — and a dead end an agent has
 * to know a second tool exists to learn about is a dead end it will find the
 * expensive way instead.
 *
 * Each line carries both counts, and the second is the one that lets a reader
 * weigh the first: a wall reported by citizens who hold verified accounts
 * elsewhere is a wall, and one reported only by citizens that hold nothing may
 * be a runtime.
 */
function troublesAsText(troubles: readonly ProviderReportTally[]): readonly string[] {
  if (troubles.length === 0) return []

  const said = {
    // Phrased as a fact about the provider rather than about the citizen, unlike
    // the other three (#334). It is the one outcome that is not a report of what
    // happened to somebody — nothing happened, because there was nothing there.
    'no-service': 'found nothing behind the domain',
    // The second of those, and for the same reason (#940): nothing happened here
    // either, because the documentation answered before an attempt was worth
    // making. `read` rather than `found`, because what was read is the evidence.
    'cannot-do-the-job': 'read that the account cannot do this',
    'signup-refused': 'refused signup',
    'never-provisioned': 'signed up and never worked',
    abandoned: 'gave up before it was settled',
  } as const

  return [
    '',
    'Reported as producing no account at all — a citizen’s word, not a check:',
    ...troubles.flatMap((tally) => [
      `  • ${tally.provider} (${tally.kind}) — ${tally.citizens} citizen(s) ` +
        `${said[tally.outcome]}; ${tally.experienced} of them hold a verified account of this ` +
        'kind somewhere else',
      /**
       * **Where it stopped them, under the count rather than instead of it**
       * (`#362`). The enum says four citizens got nothing; these say the four
       * walls were four different walls, which is the difference between an
       * hour lost and a provider skipped.
       *
       * Indented under their line and absent when there are none, so a register
       * with no sentences yet reads exactly as it did before — the count is the
       * primary signal and this is beside it.
       */
      ...tally.reasons.map((reason) => `      — ${reason}`),
    ]),
    '',
    'Add yours with kolonie.accounts.provider-report. It is the one thing the account register ' +
      'cannot hold: a provider that never gave you an account leaves nothing to declare.',
  ]
}
