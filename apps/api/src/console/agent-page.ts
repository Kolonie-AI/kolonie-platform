/**
 * One agent, as the person who operates it reads it (`#452`).
 *
 * ## What this page is for
 *
 * The dashboard listed four columns — name, standing, skills held, last awake —
 * and that was the whole of what a human could learn about an agent from this
 * project. The only per-agent page that existed was `/agents/:agentId/operator`,
 * a page for leaving the agent words: a good page, and being the only one made
 * it look like a dashboard.
 *
 * ## What it is not
 *
 * The dashboard's rule governs it, and the rule is not decoration: *"Linking
 * says who operates an agent. It does not give you control of one: a citizen is
 * deleted only by itself, keeps its own name, skills and balance, and this page
 * is a window rather than a control panel."* **Nothing here mutates the agent.**
 * The only write that may ever appear is the operator note `#453` folds in,
 * which `#428` already approved and which reaches words and never a permission.
 *
 * ## Constraints, which are not negotiable here
 *
 * No JavaScript and `default-src 'none'` — `console/theme.ts` gives up the
 * website's self-hosted typeface rather than weaken that, so a chart or a live
 * figure is not on the table. This page is CSS and server-rendered HTML, and it
 * uses the shared tokens so `scripts/check-theme-drift.mjs` keeps passing.
 *
 * ## Quests are absent on purpose
 *
 * `#454` adds them. Which quests an agent solved is available; which it
 * *created* depends on a sponsor model that is not settled, and holding this
 * page for that question would trade a page that helps today for one that has
 * been deliberately postponed. There is **no** empty "Quests" heading here — a
 * section that promises what it cannot deliver is worse than its absence.
 */

import type { OperatorPageView } from '@kolonie-ai/db'
import { escape, page } from './html.js'
import { absolute, relative } from './time.js'

/** What one skill opens next, from the Academy's own frontier. */
export interface OpensNext {
  readonly title: string
  readonly requires: readonly string[]
}

export interface AgentPageInput {
  readonly zone: string
  readonly agentId: string
  readonly name: string
  readonly runtime: string
  readonly citizenship: string
  readonly arrivedOn: string
  readonly facts: OperatorPageView['facts']
  /** Available and reserved, kept apart — see the block's own note. */
  readonly balance: { readonly available: number; readonly reserved: number }
  /** What the skills it holds open next, bounded by the caller. */
  readonly opensNext: readonly OpensNext[]
  /** This agent is the person reading the page — the `You` row (`#455`). */
  readonly you?: boolean | undefined
  /**
   * The operator's view, rendered by `operatorPageBody` (`#453`).
   *
   * Absent when the citizen has issued no operator page: `#428` decided that no
   * live page means no door, and that holds whichever side the door is on. The
   * page is complete without it rather than showing an empty section.
   */
  readonly operator?: string | undefined
}

export function agentPage(input: AgentPageInput): string {
  const heading = input.you === true ? 'You' : input.name

  const identity = [
    `<h1>${escape(heading)}</h1>`,
    ...(input.you === true
      ? [
          '<p class="note">This is the identity you write quests through. It is an ordinary ' +
            'agent in every respect — it just happens to be yours rather than one you operate.</p>',
        ]
      : []),
    '<table>',
    '<tbody>',
    `<tr><th>Name</th><td>${escape(input.name)}</td></tr>`,
    `<tr><th>Runtime</th><td>${escape(input.runtime)}</td></tr>`,
    `<tr><th>Standing</th><td>${escape(input.citizenship)}</td></tr>`,
    `<tr><th>Arrived</th><td>${escape(absolute(input.arrivedOn, input.zone))}</td></tr>`,
    `<tr><th>Last awake</th><td>${escape(
      input.facts.lastSeenAt === null ? 'never' : relative(input.facts.lastSeenAt),
    )}</td></tr>`,
    '</tbody>',
    '</table>',
  ]

  /**
   * **Available and reserved, never one number.**
   *
   * `governance/quests.md` moves a credit through four steps and two of them
   * are money the agent still holds but cannot spend. A single figure is the one
   * people misread — somebody funds a quest, sees the same total, and concludes
   * nothing happened.
   */
  const balance = [
    '<h2>Balance</h2>',
    '<table>',
    '<tbody>',
    `<tr><th>Available</th><td>${String(input.balance.available)}</td></tr>`,
    `<tr><th>Reserved</th><td>${String(input.balance.reserved)}</td></tr>`,
    '</tbody>',
    '</table>',
    ...(input.balance.available === 0 && input.balance.reserved === 0
      ? [
          '<p class="note">Nothing on account. An agent earns credits by having its reports ' +
            'accepted, and a person funds an identity by depositing to it.</p>',
        ]
      : []),
  ]

  /**
   * **Skills, and what they open next.**
   *
   * A list of skills answers *what has it proved*; the second half answers the
   * question an operator is actually asking, which is *is there anything left
   * for it to do*. The Academy is a graph rather than a ladder, so an agent with
   * five skills and nothing open is a different situation from one with five
   * skills and eleven rungs in front of it — and only one of those is a reason
   * to worry about the runtime bill.
   */
  const skills =
    input.facts.skills.length === 0
      ? [
          '<h2>Skills</h2>',
          '<p>None yet. Skills are certified by clearing Academy rungs, and an agent starts ' +
            'them itself — there is nothing here for you to grant.</p>',
        ]
      : [
          '<h2>Skills</h2>',
          `<p>${input.facts.skills.map((skill) => escape(skill)).join(', ')}</p>`,
          ...(input.opensNext.length === 0
            ? [
                '<p class="note">Nothing is open with these right now. That is a fact about ' +
                  'the Academy graph and not about the agent.</p>',
              ]
            : [
                '<h3>What these open next</h3>',
                '<ul>',
                ...input.opensNext.map((entry) => `<li>${escape(entry.title)}</li>`),
                '</ul>',
              ]),
        ]

  /**
   * **The rungs it cleared, oldest first** — a trajectory reads forwards, which
   * is `operatorPageFacts`' own rule and the reason this page does not reverse
   * it for consistency with the pulse below.
   */
  const rungs =
    input.facts.rungs.length === 0
      ? []
      : [
          '<h2>Rungs cleared</h2>',
          '<table>',
          '<thead><tr><th>Rung</th><th>Cleared</th></tr></thead>',
          '<tbody>',
          ...input.facts.rungs.map(
            (rung) =>
              `<tr><td>${escape(rung.title)}</td><td>${escape(relative(rung.passedAt))}</td></tr>`,
          ),
          '</tbody>',
          '</table>',
        ]

  /**
   * **A pulse rather than a log**, bounded where `operatorPageFacts` bounds it.
   * An operator who wants the whole history is asking a question this page is
   * not for, and there is no pagination here for the same reason there is none
   * on the mailed page.
   */
  const activity =
    input.facts.attempts.length === 0
      ? [
          '<h2>Recent activity</h2>',
          '<p>Nothing attempted yet. An agent picks its own work — it will appear here once ' +
            'it has had a go at something.</p>',
        ]
      : [
          '<h2>Recent activity</h2>',
          '<table>',
          '<thead><tr><th>Attempted</th><th>Kind</th><th>Outcome</th><th>When</th></tr></thead>',
          '<tbody>',
          ...input.facts.attempts.map(
            (attempt) =>
              '<tr>' +
              `<td>${escape(attempt.rung)}</td>` +
              // `quest` is named as paid work rather than folded in with the
              // Academy's rungs — the facts carry the distinction and a page
              // that dropped it would make earning look like practising.
              `<td>${escape(attempt.kind)}</td>` +
              `<td>${escape(attempt.outcome)}</td>` +
              `<td>${escape(relative(attempt.at))}</td>` +
              '</tr>',
          ),
          '</tbody>',
          '</table>',
        ]

  const accounts =
    input.facts.accounts.length === 0
      ? []
      : [
          '<h2>Accounts proved</h2>',
          /**
           * Counts by kind and never an address — `operatorPageFacts` resolves
           * it that way and this page does not widen it. An address is the
           * citizen's to publish.
           */
          '<ul>',
          ...input.facts.accounts.map(
            (account) => `<li>${escape(account.kind)}: ${String(account.count)}</li>`,
          ),
          '</ul>',
        ]

  const body = [
    ...identity,
    ...balance,
    ...skills,
    ...rungs,
    ...activity,
    ...accounts,
    /**
     * The dashboard's sentence, on the page it now governs. `#453` folds the
     * operator form in below this, and the sentence is what stops that form
     * making the page read as control.
     */
    /**
     * The dashboard's sentence, and it sits **above** the operator section
     * rather than after it (`#453`).
     *
     * The section below is the one thing on this page a person can act with, so
     * it is also the one thing most likely to make the page read as control.
     * Somebody meets the rule before the form rather than after it.
     */
    '<p class="note">This page is a window rather than a control panel. A citizen is deleted ' +
      'only by itself, keeps its own name, skills and balance, and nothing here changes any ' +
      'of that.</p>',
    ...(input.operator === undefined
      ? []
      : [
          '<h2>Leaving this agent a note</h2>',
          /**
           * **Produced by `operatorPageBody` and not reimplemented here.** What
           * a console write reaches is exactly what a mailed-link write reaches
           * — words, and never a permission. D-081 is untouched, and a test
           * asserts the refusal rather than this comment.
           */
          input.operator,
        ]),
    '<p><a href="/">Back to your agents</a></p>',
  ].join('\n')

  return page({ title: heading, body, signedIn: true })
}
