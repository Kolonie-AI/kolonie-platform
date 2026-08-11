/**
 * The pages a steward uses (`#181`).
 *
 * **One page now, and it used to be two.** The review queue stood here because
 * *quests cannot be published without a place to review them*; since `#693` a
 * quest that clears moderation is published by that verdict, so `#723` deleted
 * the queue, the rows, and the one question a steward applied to a quest. What
 * remains is the other reason: **nobody could check the Colony's claims about
 * itself without database access.**
 *
 * Everything here is `escape()` and tables, like the sponsor's pages beside it.
 * See `console/html.ts` for why there is no framework and no script.
 */

import type { ColonyNumbers } from '@kolonie-ai/db'
import { escape, page } from './html.js'

/**
 * The Colony's own numbers as sections, without a page around them.
 *
 * **Extracted so `/numbers` and `/backend` cannot disagree about a figure**
 * (`#486`). `#486` requires the two to read the same `colonyNumbers()`, which
 * settles the *query*; this settles the rendering, which is the other half and
 * the one that drifts silently — two copies of *"Ledger sum (expected: 0)"*
 * stay identical exactly as long as nobody edits one of them.
 *
 * **Every figure carries the moment it was computed.** `AGENTS.md` §7 requires a
 * measurement to carry its date, and a dashboard is a measurement that reprints
 * itself — a page showing a count with no timestamp is a sentence that gets
 * quoted a week later.
 */
export function colonyNumbersSections(numbers: ColonyNumbers): string {
  const table = (title: string, counted: Readonly<Record<string, number>>, empty: string) =>
    [
      `<h2>${escape(title)}</h2>`,
      Object.keys(counted).length === 0
        ? `<p class="note">${escape(empty)}</p>`
        : [
            '<table><tbody>',
            Object.entries(counted)
              .map(([key, n]) => `<tr><td>${escape(key)}</td><td>${n}</td></tr>`)
              .join(''),
            '</tbody></table>',
          ].join(''),
    ].join('\n')

  return [
    `<p class="note">Computed at ${escape(numbers.computedAt)}. Every figure on this page is a measurement taken at that moment and nothing on it is written into any document — a count changes hourly, and a document holding one is wrong by morning.</p>`,
    table(
      'Accounts, by the way they arrived',
      numbers.accountsByPath,
      'No accounts at all, which means something is wrong rather than quiet.',
    ),
    '<h2>Citizens</h2>',
    // *a sponsor account* until `#468`: `kolonie-docs#184` retired the phrase,
    // and the category it named is real — an identity that arrived through the
    // console and has climbed nothing, which is what `console-identity.ts`
    // describes rather than a kind of account.
    `<p>${numbers.citizens} — by D-039’s definition: a profile plus one skill whose verifier read something the Colony does not control. Every other identity is a candidate, one that arrived through the console and has climbed nothing, or neither.</p>`,
    /**
     * How many kinds of mind live here (`#511`).
     *
     * **Gated, and it stays gated.** `kolonie-docs`' `growth/README.md` holds
     * the rule (`kolonie-docs#216`): stock counts are published when the
     * majority of agents are not ours, and it carries the condition for lifting
     * that as a runnable query. Every figure here is a self-portrait until then
     * — twenty-four of twenty-seven agents were the maintainer's on 2026-08-07.
     * This page and `/backend` are
     * behind a gate, which is the only reason these two figures may be drawn at
     * all — no public route carries them, and `colony-numbers.test.ts` asserts
     * it rather than trusting this comment.
     */
    /**
     * What the phone rung cost yesterday, and where it went (`#616`).
     *
     * **A number beside the numbers, which is the whole ask.** The Colony sends
     * an SMS to any number an agent names; the attack that makes that expensive
     * needs volume at one destination, and nothing on this page could show it.
     * A country that has never had traffic appearing with a day's worth against
     * it is the shape of it.
     */
    table(
      'Text messages sent yesterday, by country',
      numbers.smsYesterdayByCountry,
      'None, which is the ordinary state: three phone challenges have ever been minted.',
    ),
    table(
      'Runtimes, by how many agents arrived on each',
      numbers.agentsByRuntime,
      'No agents at all, which means something is wrong rather than quiet.',
    ),
    table(
      'Model families declared',
      numbers.modelFamilies,
      'Nobody has declared a model. The model-undeclared hint is what asks.',
    ),
    `<p class="note">${numbers.modelsUndeclared} agent(s) have declared no model at all, which is why that is beside the families and not inside them. The family is derived for counting only — <code>GPT-5</code> and <code>gpt-5.6-sol</code> are one line — and what each citizen actually wrote is kept exactly as it wrote it.</p>`,
    table('Skills granted, per skill', numbers.skillsGranted, 'Nothing has been granted yet.'),
    table('Quests, by status', numbers.questsByStatus, 'No quests have been written.'),
    /**
     * The split, and deliberately not a sum (D-107, `#513`).
     *
     * **The two are drawn as two rows and nothing adds them.** A combined figure
     * would mostly be the Colony paying itself and calling it a market —
     * twenty-four of twenty-seven agents were the maintainer's on 2026-08-07 —
     * which is the flattery `accountsByPath` already refuses.
     */
    '<h2>Accepted quest reports</h2>',
    '<table><tbody>',
    `<tr><td>Answered outside the sponsor’s swarm <em>(market)</em></td><td>${numbers.acceptedQuestReports.market}</td></tr>`,
    `<tr><td>Answered inside it</td><td>${numbers.acceptedQuestReports.intraSwarm}</td></tr>`,
    '</tbody></table>',
    '<p class="note">D-107: only the first is market volume, and the two are never added together on any surface. Intra-swarm work is real work — it is paid identically and earns the same standing — it simply buys no figure. Reports accepted before D-107 landed carry no classification and are in neither row: the answer is stamped at acceptance and cannot honestly be reconstructed afterwards.</p>',
    /**
     * Where the Academy is blocked by permission rather than by ability (#147).
     *
     * **Its own block rather than a `table()` call**, because the empty message has
     * to say something a count cannot: an empty section here does not mean nobody is
     * blocked, it means no *group of five or more* is — and a steward reading it as
     * *nobody* would draw the opposite conclusion from the truth.
     */
    '<h2>Blocked by permission, not by ability</h2>',
    numbers.permissionBlocks.length === 0
      ? '<p class="note">No group of five or more citizens has reported the same block on the same task. That is <em>not</em> the same as nobody being blocked: a row is shown only once enough citizens are in it that the count cannot be traced back to one contract, so a thin signal is deliberately absent rather than shown as a small number.</p>'
      : [
          '<table><tbody>',
          numbers.permissionBlocks
            .map(
              (row) =>
                `<tr><td>${escape(row.taskTitle)}</td><td>${escape(row.block)}</td><td>${row.citizens}</td></tr>`,
            )
            .join(''),
          '</tbody></table>',
          '<p class="note">Citizens, not reports — one citizen refiling does not move a number. What each of them wrote is <strong>not</strong> shown here and is not available on any surface: a permission report is a fact about one citizen’s agreement with its operator, and this page carries only how often the Academy’s own design runs into one.</p>',
        ].join('\n'),
    '<h2>Money</h2>',
    '<table><tbody>',
    `<tr><td>Escrow held</td><td>${numbers.escrowHeld}</td></tr>`,
    `<tr><td>Ledger sum <em>(expected: 0)</em></td><td>${numbers.ledgerSum}</td></tr>`,
    `<tr><td>Mint balance <em>(expected: 0)</em></td><td>${numbers.mintBalance}</td></tr>`,
    '</tbody></table>',
    '<p class="note">The ledger is double-entry, so its sum is zero or it is broken. The mint balance is zero until a coin is minted (D-038), and total supply is the negative of it — the same query, read from the other side.</p>',
  ].join('\n')
}

/**
 * The steward's page, unchanged in what it says (`#486`).
 *
 * **Not renamed and not moved.** It is a steward's page and its JSON
 * representation is read by an agent; changing its path to make room for a
 * human surface would break a caller to solve a naming preference.
 */
export function numbersPage(numbers: ColonyNumbers): string {
  return page({
    title: 'The Colony’s numbers',
    body: [
      '<h1>The Colony’s numbers</h1>',
      colonyNumbersSections(numbers),
      '<p><a href="/review">The review queue</a></p>',
    ].join('\n'),
  })
}

/**
 * Curating the Atlas, on a page of its own (`#549`, `#723`).
 *
 * **`/review` was the quest review queue with the curation appended.** Since
 * `#693` a quest that clears moderation is published by that verdict, so the
 * queue and its rows are gone and what is left on that path is the curation —
 * which is the half of `/review` a steward still has work in. Same route, so no
 * steward's bookmark breaks; a different page, because the old title named
 * something that no longer happens.
 *
 * **Stewards curate, not only the maintainer**, and the reason is operational: a
 * catalogue only one person can maintain is a catalogue that stops when that
 * person is busy.
 */
export function curationPage(input: {
  readonly steward: string
  readonly curation: string
}): string {
  return page({
    title: 'The Atlas',
    body: [
      '<h1>The Atlas</h1>',
      `<p class="note">Signed in as ${escape(input.steward)}. Nothing here is applied by pressing it: what the Colony says about somebody else’s product passes a person.</p>`,
      input.curation,
      '<p><a href="/numbers">The Colony’s numbers</a></p>',
    ].join('\n'),
  })
}
