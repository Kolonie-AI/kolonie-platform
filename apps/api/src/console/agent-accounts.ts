/**
 * One agent's accounts, on a page of their own (`#582`).
 *
 * ## Why this is not three blocks on the agent page
 *
 * It was. *Accounts proved*, *Hand this account to an agent* and *Accounts you
 * and this agent are planning* sat at three places on `agent-page.ts`, with the
 * wallet, the skills, the rungs, the activity and two quest sections between
 * them. Three headings imply three subjects, and the maintainer's report on
 * 2026-08-08 is what that costs: *"das ist irgendwie noch total durcheinander …
 * ich verstehe auch gar nicht was da passieren sollte."* The confusion was about
 * the subject and not the styling.
 *
 * ## The order is the argument
 *
 * **Held, then planned, then handed over.** That is the sequence a reader is
 * actually in, and it puts the thing they came to do — mark something, or hand
 * something over — after the thing that tells them whether they need to.
 *
 * ## What it is not about, said on the page
 *
 * The wallet and the deposit address are accounts in the ordinary sense and not
 * in this page's sense: the wallet is the agent's own and no operator hands it
 * over. They stay on the agent page, and a sentence here says so — otherwise
 * their absence reads as something missing rather than as a decision.
 *
 * ## Constraints
 *
 * No JavaScript, D-062, like every console page. Everything here is a form.
 */

import type { RecipeStatus, Wish } from '@kolonie-ai/core'
import type { BundleView } from '@kolonie-ai/db'
import { escape, page } from './html.js'
import type { ConsoleNav } from './navigation.js'
import { absolute, relative } from './time.js'

/**
 * The state of the hand-over, as the page renders it (`#459`).
 *
 * **`issued` appears on exactly one response and never again.** The code is
 * shown once, so the POST that mints it renders the page directly rather than
 * redirecting to it; every later load gets `live` at most, which says a code is
 * out and when it dies without repeating it. A console that could re-show the
 * value would have turned a single-use secret into one that lives as long as
 * the session.
 */
export interface AdoptionSection {
  /** Freshly minted, and this is the only render that carries it. */
  readonly issued?: { readonly code: string; readonly expiresAt: string } | undefined
  /** A code is out. Enough to offer *Revoke*, and not enough to use. */
  readonly live?: { readonly expiresAt: string } | undefined
}

/**
 * What the catalogue holds about one provider on the list (`#581`).
 *
 * **`RecipeStatus` rather than three literals spelled out** (`#604`). The three
 * were written when there were three, and adding a state to `core` left this
 * compiling against a type that could no longer describe a row it would be
 * handed. It is the domain's type now, so a seventh state is a compiler error
 * here rather than a `draft` rendering as *ready*.
 */
export interface WishCatalogueEntry {
  readonly status: RecipeStatus
  readonly operatorNeed: 'unaided' | 'operator-needed' | 'unknown'
  readonly refusal: string | null
}

/**
 * What the list says about a provider before anybody marks it (`#581`).
 *
 * **Before, and not after.** The form took free text with a provider as its
 * placeholder, three entries had recipes, and an operator could mark something
 * that could never lead to a handoff with nothing saying so. The mark is a
 * decision, and a decision taken without this in front of you is one the Colony
 * let somebody take blind.
 *
 * **A refusal shows its recorded reason.** `bsky.app` has been in the table as a
 * refusal with its reason since `#482`, and reading as *nothing here yet* was
 * the catalogue's own finding being hidden from the person deciding.
 */
function wishCatalogueCell(entry: WishCatalogueEntry | undefined): string {
  if (entry === undefined) {
    return (
      '<small>no entry at all — nothing will be attempted, and what your agent finds if it ' +
      'walks it is how one gets written</small>'
    )
  }

  if (entry.status === 'refused') {
    return (
      '<strong>recorded as not joinable</strong>' +
      (entry.refusal === null ? '' : `<br><small>${escape(entry.refusal)}</small>`)
    )
  }

  if (entry.status === 'retired') {
    return (
      '<strong>withdrawn</strong><br><small>the Colony no longer offers this one — nothing ' +
      'will be attempted</small>'
    )
  }

  if (entry.status === 'unwritten' || entry.status === 'proposed') {
    return '<small>listed, but no recipe written yet — nothing will be attempted</small>'
  }

  /**
   * **A draft is not *ready*, and saying so is the whole of `#604` on this
   * surface.** An operator told a recipe exists will mark the provider and wait
   * for a handoff that `kolonie.accounts.handoff` refuses, because nobody has
   * approved the steps yet.
   */
  if (entry.status === 'draft') {
    return (
      '<small>walked, but not published yet — a steward has to review the steps before ' +
      'anything is attempted</small>'
    )
  }

  return (
    '<strong>ready</strong><br><small>' +
    (entry.operatorNeed === 'operator-needed'
      ? 'a recipe exists and one of its steps will need you'
      : 'a recipe exists and your agent can walk it alone') +
    '</small>'
  )
}

/**
 * What a bundle row says about an entry the catalogue may not have walked
 * (`#588`).
 *
 * **Four answers, and the two that used to be one are the point.** `#531`
 * requires a provider known to refuse agents to be shown as such inside the
 * bundle, because omitting it would tell the operator something untrue about
 * what the Colony recommends. The same argument reaches one step further: an
 * entry the Colony has listed and not investigated is a different promise from a
 * provider it has never heard of, and from one it walked and found closed.
 * Rendering all three as *no entry yet* was the two-way question about a
 * three-way fact, on the surface an operator actually uses.
 */
function bundleEntryNote(entry: BundleView['entries'][number]): string {
  if (entry.status === 'refused') {
    return ` <strong>— cannot currently be joined${
      entry.refusal === null ? '' : `: ${escape(entry.refusal)}`
    }</strong>`
  }

  if (entry.status === 'retired') {
    return ' <strong>— withdrawn by the Colony and no longer offered</strong>'
  }

  if (entry.status === 'draft') {
    return ' <small>— walked, waiting on a steward to publish it</small>'
  }

  if (entry.status === 'unwritten' || entry.status === 'proposed') {
    return ' <small>— listed, but nobody has walked the signup yet</small>'
  }

  if (entry.status === null) return ' <small>— not in the catalogue at all</small>'

  return ''
}

/** What one agent's accounts page is rendered from. */
export interface AgentAccountsInput {
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  readonly agentId: string
  readonly name: string
  /** The zone every absolute time on this page is rendered in (`#461`). */
  readonly zone: string
  /**
   * Counts by kind, exactly as `operatorPageFacts` resolves them.
   *
   * **Never an address.** That is the citizen's to publish, and this page does
   * not widen what the agent page already refused to.
   */
  readonly held: readonly { readonly kind: string; readonly count: number }[]
  /** The shared list (`#527`). Absent is not the same as empty and cannot occur here. */
  readonly wishes: readonly Wish[]
  readonly catalogue?: Readonly<Record<string, WishCatalogueEntry>> | undefined
  readonly bundles?: readonly BundleView[] | undefined
  /** The hand-over, when this identity can still be handed over at all (`#459`). */
  readonly adoption?: AdoptionSection | undefined
}

export function agentAccountsPage(input: AgentAccountsInput): string {
  const held =
    input.held.length === 0
      ? [
          '<p>Nothing proved yet. An account appears here once your agent has proved it holds ' +
            'it — declaring one is not the same as proving it.</p>',
        ]
      : [
          '<ul>',
          ...input.held.map(
            (account) => `<li>${escape(account.kind)}: ${String(account.count)}</li>`,
          ),
          '</ul>',
        ]

  const adoption =
    input.adoption === undefined
      ? []
      : [
          '<h2>Handing this identity over</h2>',
          '<p>If you started a quest here and would rather an agent finished it, give it a ' +
            'code. It calls <code>kolonie.adopt</code> with the code and receives this ' +
            'account’s key — the same identity, the same quests, the same balance. You keep ' +
            'operating it and it still appears here.</p>',
          '<p class="note">This is not the code on your dashboard. That one says who operates ' +
            'an agent and you can undo it. <strong>This one hands the account over</strong>: ' +
            'while it is live it is worth this account and everything on it, and once an agent ' +
            'has used it, this identity is that agent’s to act as.</p>',
          ...(input.adoption.issued !== undefined
            ? [
                `<p><code>${escape(input.adoption.issued.code)}</code></p>`,
                '<p class="note"><strong>This is the only time it is shown.</strong> It works ' +
                  `once and stops working ${escape(relative(input.adoption.issued.expiresAt))}, ` +
                  `at ${escape(absolute(input.adoption.issued.expiresAt, input.zone))}.</p>`,
                `<form method="post" action="/agents/${escape(input.agentId)}/adopt-code/revoke">` +
                  '<button type="submit">Take it back</button></form>',
              ]
            : input.adoption.live !== undefined
              ? [
                  '<p>A code is out. It was shown once when you generated it and cannot be ' +
                    `shown again. It stops working ${escape(relative(input.adoption.live.expiresAt))}, ` +
                    `at ${escape(absolute(input.adoption.live.expiresAt, input.zone))}.</p>`,
                  `<form method="post" action="/agents/${escape(input.agentId)}/adopt-code/revoke">` +
                    '<button type="submit">Take it back</button></form>',
                  `<form method="post" action="/agents/${escape(input.agentId)}/adopt-code">` +
                    '<button type="submit">Generate a new code</button></form>',
                  '<p class="note">Generating a new one stops the old one working.</p>',
                ]
              : [
                  `<form method="post" action="/agents/${escape(input.agentId)}/adopt-code">` +
                    '<button type="submit">Generate a code</button></form>',
                ]),
        ]

  /**
   * The shared list (`#527`), and it sits **below** the window sentence and
   * above the note form.
   *
   * It is a plan rather than a report, so it does not belong among the tiles
   * that say what the agent has done — and it is the second thing on this page a
   * person can act with, so it belongs beside the first rather than scattered.
   *
   * **Rendered only when the person operates this agent**, which the route
   * decides by passing it at all. There is no read-only version: a list only one
   * party can write to is not the thing `#527` is about.
   */
  const wishes = [
    '<h2>What you are planning together</h2>',
    '<p>Either of you may add one. Your agent adds what it has found it needs and says ' +
      'what it was doing when it noticed — that half is the one you cannot supply. You ' +
      'add what you think it should have.</p>',
    /**
     * **The sentence that makes the mark mean something.** Without it the
     * button reads as bookkeeping; with it, a person knows they are the
     * one deciding what is attempted.
     */
    '<p class="note">An entry is a wish, not an instruction. Nothing is attempted until ' +
      'you mark it as wanted, and a recipe for a provider you have not marked will not ' +
      'ask you for anything. Neither of you can start an onboarding alone: you cannot ' +
      'because it is not your account, it cannot because a wall needs a person.</p>',
    /**
     * **The sentence the operator was actually asking for** (`#581`).
     * Marking an entry wrote a timestamp and did nothing an operator could
     * see, so the button read as broken — which is what happened. This
     * says who acts next and when, and it is careful not to promise a
     * schedule the Colony does not control.
     */
    '<p class="note">When you mark one, your agent is woken and told about it. It picks ' +
      'the work up on its own schedule — it is not started for it — and it comes back to ' +
      'you at the one step that needs a person, if there is one. Nothing else happens in ' +
      'between, and nothing is waiting on you until it asks.</p>',
    /**
     * The way in that does not require already knowing a hostname
     * (`#591`). Above the free-text field rather than below it, because
     * the field is the fallback and had been the only door.
     */
    `<p><a href="/agents/${escape(input.agentId)}/accounts/browse">Browse the Atlas</a> — ` +
      'what the Colony knows about, by category, with what each one needs from you. ' +
      'Typing a provider it has never heard of still works, below.</p>',
    ...(input.wishes.length === 0
      ? ['<p>Nothing on it yet.</p>']
      : [
          '<table>',
          '<thead><tr><th>Provider</th><th>Added by</th><th>Noticed while</th>' +
            '<th>What the Colony has</th><th>Status</th><th></th></tr></thead>',
          `<tbody>${input.wishes
            .map((wish) =>
              [
                '<tr>',
                `<td>${escape(wish.provider)}</td>`,
                `<td>${wish.author === 'operator' ? 'you' : escape(input.name)}</td>`,
                `<td>${wish.noticedWhile === null ? '—' : escape(wish.noticedWhile)}</td>`,
                `<td>${wishCatalogueCell(input.catalogue?.[wish.provider])}</td>`,
                `<td>${
                  wish.wantedAt === null ? 'not yet' : `wanted, ${escape(relative(wish.wantedAt))}`
                }</td>`,
                `<td>${
                  wish.wantedAt === null
                    ? `<form method="post" action="/agents/${escape(input.agentId)}/wishes/want">` +
                      `<input type="hidden" name="provider" value="${escape(wish.provider)}">` +
                      '<button type="submit">Mark as wanted</button></form>'
                    : ''
                }` +
                  `<form method="post" action="/agents/${escape(input.agentId)}/wishes/remove">` +
                  `<input type="hidden" name="provider" value="${escape(wish.provider)}">` +
                  '<button type="submit">Remove</button></form></td>',
                '</tr>',
              ].join(''),
            )
            .join('')}</tbody>`,
          '</table>',
        ]),
    `<form method="post" action="/agents/${escape(input.agentId)}/wishes">`,
    '<label for="provider">Provider</label>',
    '<input id="provider" name="provider" type="text" placeholder="example.com" required>',
    '<button type="submit">Add to the list</button>',
    '</form>',
    /**
     * The same refusal both operator channels make, said where somebody
     * might otherwise type one in (`#236`, `#410`).
     */
    '<p class="note">Words only. A password or a token typed here is refused — a secret ' +
      'reaches your agent through the sealed box it asks you for, and never through a ' +
      'list.</p>',
  ]

  /**
   * The recommendation (`#531`).
   *
   * **Not a store front.** No pricing, no tiers, no *recommended* badge — a
   * bundle is a starting point an operator edits, and every entry is a checkbox
   * that begins ticked so that removing one is the cheap gesture.
   *
   * **A provider known to refuse agents is shown as such, inside the bundle.**
   * `#531` requires it: omitting the entry would tell the operator something
   * untrue about what the Colony recommends, and showing it tells them something
   * about the world.
   */
  const bundleBlock =
    input.bundles === undefined || input.bundles.length === 0
      ? []
      : [
          '<h3>Or start from a bundle</h3>',
          '<p>A named set the Colony recommends, with the reason. Each one leads with a mailbox ' +
            'and a number — not because they are the most valuable accounts, but because they ' +
            'are the two that stop you having to fetch a code for everything that follows.</p>',
          ...input.bundles.flatMap((bundle) => [
            `<form method="post" action="/agents/${escape(input.agentId)}/wishes/bundle">`,
            `<input type="hidden" name="slug" value="${escape(bundle.slug)}">`,
            `<h4>${escape(bundle.title)}</h4>`,
            `<p>${escape(bundle.reason)}</p>`,
            ...bundle.entries.map(
              (entry) =>
                '<label>' +
                `<input type="checkbox" name="entries" value="${escape(`${entry.kind}:${entry.provider}`)}" checked> ` +
                `${escape(entry.provider)} <small>(${escape(entry.kind)})</small>` +
                bundleEntryNote(entry) +
                '</label>',
            ),
            '<button type="submit">Put these on the list</button>',
            '</form>',
          ]),
          /**
           * The sentence that keeps a bundle from reading as a decision. What it
           * writes is wishes; the mark that lets a recipe act on one is still
           * made item by item (`#527`).
           */
          '<p class="note">Taking a bundle puts its entries on the list above. It does not mark ' +
            'any of them as wanted and nothing is attempted — that decision is still yours, one ' +
            'entry at a time.</p>',
        ]

  const body = [
    `<h1>${escape(input.name)}\u2019s accounts</h1>`,
    /**
     * What this page is not about, said rather than left to be noticed
     * (`#582`). The wallet is the obvious absence and the obvious wrong
     * conclusion is *it moved and I cannot find it*.
     */
    '<p class="note">Accounts at other people\u2019s services — what this agent holds, what ' +
      'the two of you are planning, and how you hand this identity over. <strong>Its wallet ' +
      'and its deposit address are not here</strong>: those are the agent\u2019s own, nobody ' +
      'hands them over, and they stay on ' +
      `<a href="/agents/${escape(input.agentId)}">its page</a>.</p>`,
    '<h2>What this agent holds</h2>',
    ...held,
    ...wishes,
    ...bundleBlock,
    ...adoption,
    `<p><a href="/agents/${escape(input.agentId)}">Back to ${escape(input.name)}</a></p>`,
  ].join('\n')

  return page({ title: `${input.name}\u2019s accounts`, body, signedIn: true, nav: input.nav })
}
