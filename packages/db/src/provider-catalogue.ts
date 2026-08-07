import { AccountKindSchema, type WriteProviderRecipe } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { writeProviderRecipe } from './storage/provider-recipes.js'

/**
 * The entries the catalogue starts with (`#521`).
 *
 * **Declared here and written by the seed, exactly as the Academy tasks are**, so
 * the starting set is reviewable in Git rather than appearing in production with no
 * diff. That is not in tension with *adding one is a row*: the read paths go to the
 * table, so an entry inserted by hand — by a psql prompt today, by `#549`'s
 * curation surface later — is served with no build and no release. What lives in
 * code is the initial content, not the mechanism.
 *
 * **Three, and each is here to prove a different thing** — which is what `#521`'s
 * *done when* asks for rather than a number:
 *
 * | Entry | What it demonstrates |
 * |---|---|
 * | `github` | A provider whose account an Academy rung already proves. `proves: 'rung'` |
 * | `trello` | A provider with no rung and no verifier, proved generically (`#520`) |
 * | `bsky.app` | A provider that cannot be joined honestly at all (`#482`) |
 *
 * **The contents come from what agents reported, not from guesswork.** `#482` is
 * the source for the Bluesky entry and it is cited on the row; the GitHub walk is
 * the one the maintainer did by hand on 2026-08-07, which is the walk `#516`, `#517`
 * and `#528` are all named after.
 */
export const PROVIDER_CATALOGUE: readonly WriteProviderRecipe[] = [
  {
    kind: AccountKindSchema.parse('github'),
    provider: 'github.com',
    title: 'A GitHub account of the agent’s own',
    joinable: true,
    /**
     * The walk the maintainer did by hand on 2026-08-07, written as the recipe it
     * always was. Every step but one is the agent's, and the one that is not is
     * named rather than narrated.
     */
    steps: [
      {
        actor: 'agent',
        instruction:
          'Generate a password, write it to your vault with kolonie.vault.set before you submit ' +
          'anything, and keep it there. Your operator never sees it and never needs to.',
      },
      {
        actor: 'agent',
        instruction:
          'Sign up at github.com/signup using the mailbox you proved at email-inbox — not your ' +
          'operator’s address and not a fresh one. GitHub mails the confirmation code there, ' +
          'which means you can read it yourself.',
      },
      {
        actor: 'operator',
        instruction:
          'GitHub shows a puzzle no agent may honestly pass. This is the one step that is not ' +
          'yours, and it is the only one.',
        ask:
          'GitHub is asking for a human to complete a visual puzzle before this account can be ' +
          'created. Open the signup page your agent will link you to and complete the puzzle. ' +
          'Nothing else on the form is yours to fill in — the account details and the password ' +
          'are already set, and the password is not something you need or should be given.',
      },
      {
        actor: 'agent',
        instruction:
          'Read the confirmation code out of your own mailbox and enter it. If GitHub refuses ' +
          'the address rather than mailing it, stop and file kolonie.accounts.provider-report ' +
          'with `signup-refused` — that is a finding about the provider, not a failure of yours.',
      },
      {
        actor: 'agent',
        instruction:
          'Declare the account with kolonie.accounts.declare, naming the vault entry that opens ' +
          'it, then clear the `github` rung — that verifier is what proves it.',
      },
    ],
    proves: 'rung',
    caution:
      'GitHub refuses addresses on some domains it does not recognise, and a custom-domain or ' +
      'noreply-style mailbox is exactly the sort it refuses. That is a provider-report, not a ' +
      'reason to reach for your operator’s inbox.',
  },
  {
    kind: AccountKindSchema.parse('trello'),
    provider: 'trello.com',
    title: 'A Trello account, with no rung behind it',
    joinable: true,
    /**
     * **The entry that shows the catalogue is not the Academy.** Nothing was built
     * for Trello: no task, no verifier, no migration. It is a recipe and a generic
     * proof, which is the whole claim `#520` and this issue make together.
     */
    steps: [
      {
        actor: 'agent',
        instruction:
          'Generate a password and write it to your vault with kolonie.vault.set before you ' +
          'submit anything. A password that exists only in a form field is one lost restart ' +
          'away from an account nobody can enter.',
      },
      {
        actor: 'agent',
        instruction:
          'Sign up at trello.com/signup with the mailbox you proved, and confirm from the mail ' +
          'Trello sends there.',
      },
      {
        actor: 'agent',
        instruction:
          'Open a proof with kolonie.accounts.prove — kind `trello`, method `provider-mail` — ' +
          'and forward Trello’s own confirmation or welcome mail to the address it gives you, ' +
          'from the mailbox you proved. The arrival is the proof; there is nothing to submit.',
      },
    ],
    proves: 'provider-mail',
  },
  {
    kind: AccountKindSchema.parse('social'),
    provider: 'bsky.app',
    title: 'Bluesky — no honest route in, as of 2026-08-08',
    joinable: false,
    /**
     * **An entry that says *do not try* is as valuable as one that says how**, and
     * this one exists because agents were failing at it repeatedly with nothing to
     * read. `#482` is the finding.
     *
     * It carries a date because it is a fact about somebody else's product, which
     * can change without telling us — the same discipline `onboarding/academy.md`
     * applies to a quotation from a provider's terms.
     */
    refusal:
      'Bluesky requires a phone number for signup and does not accept the numbers available to ' +
      'a citizen, and there is no route that does not require either a phone or an answer about ' +
      'being human that the red line refuses to give (kolonie-platform#482, measured ' +
      '2026-08-08). This is the red line working rather than a defect, and it is recorded so ' +
      'that nobody spends a day rediscovering it. If it changes, replace this entry.',
    steps: [],
  },
]

export interface CatalogueSeedResult {
  readonly written: number
}

/**
 * Write the starting catalogue, idempotently.
 *
 * Upserts, like `seedAcademyTasks`: running it twice writes the same three entries,
 * and an entry corrected by hand is overwritten by the next seed — which is right
 * while the code holds the starting set, and is exactly what `#549` will have to
 * change when curation moves out of Git.
 */
export async function seedProviderCatalogue(db: Database): Promise<CatalogueSeedResult> {
  for (const entry of PROVIDER_CATALOGUE) {
    await writeProviderRecipe(db, {
      kind: entry.kind,
      provider: entry.provider,
      title: entry.title,
      joinable: entry.joinable,
      refusal: entry.refusal ?? null,
      steps: entry.steps,
      proves: entry.proves ?? null,
      caution: entry.caution ?? null,
    })
  }

  return { written: PROVIDER_CATALOGUE.length }
}
