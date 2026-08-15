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

import {
  ENTRY_BODY_MAX_LENGTH,
  KNOWN_ACCOUNT_KINDS,
  SLOT_LABEL_MAX_LENGTH,
  SLOT_VALUE_MAX_LENGTH,
  type Account,
  type AccountStatus,
  type EpisodeTurn,
  type RecipeStatus,
  type ThreadParty,
  type Wish,
} from '@kolonie-ai/core'
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
  /**
   * What sort of account the entry is for, where the catalogue names one (`#936`).
   *
   * **A prefill and never a constraint.** It saves the operator typing *mailbox*
   * under a provider whose only recipe is a mailbox; the field it fills stays a
   * `<datalist>`, because a provider the Colony has walked for one kind is a
   * provider somebody may hold an entirely different sort of account at.
   */
  readonly kind?: string | undefined
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
 * The one button between a wanted wish and a conversation (`#936`).
 *
 * **A wish that has been marked as wanted had nowhere to go.** The mark woke the
 * agent and then both parties waited for the other to start something, on a row
 * whose only remaining control was *Remove*. This is the missing move, and it is
 * deliberately the same move `#933` made from the other direction: an
 * `acquisition` episode, opened by the operator, with the turn on the agent.
 *
 * **It asks for the kind and the identifier because an episode cannot exist
 * without an account, and an account cannot exist without both.** A placeholder
 * would be a second record of a fact — the wrong identifier, permanently, with
 * no rename path — which is D-002 arriving as a convenience. For nearly every
 * provider the identifier is a choice somebody makes at signup, and the wish
 * list is exactly where the two parties are planning that together.
 *
 * **A wish whose conversation is already open shows the way in and not the
 * form.** Opening a second acquisition about the same account is refused
 * downstream; offering the button anyway would be D-013.
 */
function wishStartCell(input: AgentAccountsInput, wish: Wish): string {
  const open = input.conversations?.[wish.provider]
  if (open !== undefined) {
    return (
      `<p><a href="/agents/${escape(input.agentId)}/accounts/${escape(open)}">` +
      'Open the conversation</a></p>'
    )
  }

  const kind = input.catalogue?.[wish.provider]?.kind ?? ''

  return (
    `<form method="post" action="/agents/${escape(input.agentId)}/wishes/start">` +
    `<input type="hidden" name="provider" value="${escape(wish.provider)}">` +
    '<p><label>What sort of account? ' +
    `<input name="kind" list="account-kinds" required maxlength="32" value="${escape(kind)}">` +
    '</label></p>' +
    '<p><label>What will it be held under? ' +
    '<input name="identifier" required maxlength="320">' +
    '</label><br><small>The handle or address the account will have. Your agent cannot ' +
    'invent this one for you — a name chosen at signup is chosen once.</small></p>' +
    '<button type="submit">Start the conversation</button></form>'
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

/**
 * Whose turn it is on an open episode, said to the person reading (`#934`).
 *
 * **`nobody` is a real answer and is not *the agent's*.** An episode nobody owes
 * anything on is one both of them may leave alone, and printing the agent's name
 * there would be this page inventing an obligation.
 */
function turnCell(turn: EpisodeTurn, name: string): string {
  if (turn === 'operator') return 'yours'
  if (turn === 'agent') return `${escape(name)}’s`
  return 'nobody’s'
}

/**
 * One held account, as this page renders it (`#928`).
 *
 * **The identifier is here, and this is the only operator surface it reaches.**
 * Every other rule on this page says the opposite — `#582` kept addresses off
 * it, `#934` composes an episode title from the kind and the provider precisely
 * so that none appears. The difference is who is reading. Those two are also
 * reachable from the *mailed* operator page, which is opened by whoever holds a
 * link; this page is behind the session of the person the join table says
 * operates the agent, which is the line `agentFacts` already draws in its own
 * words. *How are my agent's accounts doing* cannot be answered by a count.
 *
 * **Never another agent's.** The read is scoped by `agentId` in its `where`
 * clause; this type carries no agent and the projection below cannot filter by
 * one, which is deliberate — a renderer that could would be a second place the
 * rule lives, and the wrong one.
 */
export interface HeldAccountRow {
  /**
   * The row, so this line can be followed to the account's own page (`#932`).
   *
   * It was dropped on the argument that an operator had no form to spend it on.
   * That page is what spends it, and it is not an identifier of the citizen's:
   * the id is meaningless to anyone the read did not already scope to.
   */
  readonly id: string
  readonly kind: string
  /** Null where the citizen never named one. Rendered as a sentence, not a blank. */
  readonly provider: string | null
  readonly identifier: string
  /** The agent's own word on it: `in-use`, `retired`, `lost`. */
  readonly status: AccountStatus
  /** Whether something read it, as against the citizen having written it down. */
  readonly proved: boolean
  /** When a re-check last found it. Null if one never has. */
  readonly confirmedAt: string | null
  /** Set when the last re-check could not reach it, and cleared when one can. */
  readonly unconfirmedSince: string | null
}

/**
 * The register, narrowed to what this page prints (`#928`).
 *
 * Mirrors `profileAccountRows`: the narrowing is a function a reader can check
 * rather than an omission in a template. What is dropped is what belongs to the
 * citizen and not to its operator — the note it wrote itself, and the vault key
 * that opens the account.
 *
 * **The row id survives it since `#932`.** It was dropped with those two on the
 * argument that there was no form to spend it on; the account's own page is that
 * form, and an id nobody can resolve without the scoped read behind it is not a
 * thing the citizen is losing.
 *
 * **Retired and lost rows stay.** `listAccounts` returns them for the citizen's
 * own view on the argument that they are excluded from *offering* and not from
 * the record; an operator asking how the accounts are doing is asking that same
 * question, and an account the agent marked `lost` in June is the single most
 * useful row on the page.
 */
export function heldAccountRows(accounts: readonly Account[]): readonly HeldAccountRow[] {
  return accounts.map(
    (account) =>
      ({
        id: account.id,
        kind: account.kind,
        provider: account.provider,
        identifier: account.identifier,
        status: account.status,
        proved: account.proved,
        confirmedAt: account.confirmedAt,
        unconfirmedSince: account.unconfirmedSince,
      }) satisfies HeldAccountRow,
  )
}

/**
 * What the agent says about one of its own accounts (`#928`).
 *
 * **Two facts in one cell, and they are not the same fact.** `proved` is
 * something the Colony read; `status` is something the agent asserted. A cell
 * that printed only one of them would let a declared-only account the agent
 * calls `in-use` read exactly like a proved one.
 *
 * **Exported for the account's own page** (`#932`), which prints this same fact
 * in its head. Two functions saying *what the agent says about this account*
 * would be two records of one fact, which is D-002.
 */
export function heldStateCell(account: HeldAccountRow): string {
  const standing =
    account.status === 'in-use'
      ? 'in use'
      : account.status === 'retired'
        ? '<strong>retired</strong>'
        : '<strong>lost</strong>'

  return (
    standing +
    '<br>' +
    (account.proved
      ? '<small>proved — the Colony read it</small>'
      : '<small>declared only — your agent wrote it down and nothing has read it</small>')
  )
}

/**
 * When a re-check last reached the account (`#928`).
 *
 * **Never checked and last check failed must not read alike**, which the
 * acceptance criteria say outright, so they are the two ends of this function
 * rather than two shades of one sentence. `<strong>` for the failure and
 * `<small>` for the silence is the idiom this file already uses for a hard fact
 * against a soft one — the console has no warning class, and D-062 leaves no
 * script to add one.
 *
 * **A never-checked account says so in a sentence**, again as the criteria
 * require: an empty cell is indistinguishable from a page that forgot to render
 * one, and this column exists to be believed.
 *
 * `unconfirmedSince` is asked first because it is the current state whatever
 * else is set. `recordAccountRecheck` leaves an old `confirmedAt` in place when
 * a check fails, so an account confirmed in March and unreachable since May
 * carries both — and it is May that the operator needs.
 */
export function heldRecheckCell(account: HeldAccountRow, zone: string): string {
  if (account.unconfirmedSince !== null) {
    return (
      '<strong>did not answer</strong><br>' +
      `<small>last tried ${escape(relative(account.unconfirmedSince))}, at ` +
      `${escape(absolute(account.unconfirmedSince, zone))}` +
      (account.confirmedAt === null
        ? ''
        : `; it last answered ${escape(relative(account.confirmedAt))}`) +
      '</small>'
    )
  }

  if (account.confirmedAt !== null) {
    return (
      `answered ${escape(relative(account.confirmedAt))}<br>` +
      `<small>at ${escape(absolute(account.confirmedAt, zone))}</small>`
    )
  }

  /**
   * The distinction the citizen can act on: nothing is re-checked until
   * something has read it once, so *never checked* means different things for a
   * proved account and a declared one.
   */
  return account.proved
    ? '<small>never re-checked since it was proved</small>'
    : '<small>not re-checked — the Colony re-checks an account once it has been proved</small>'
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
   * The accounts themselves, one row each (`#928`).
   *
   * **Rows here, counts everywhere else.** `operatorPageFacts` keeps its
   * counts-by-kind because the *mailed* operator page is opened by whoever holds
   * a link, and `agent-page.ts` keeps its summary because it is a summary. This
   * page renders one or the other and not both: two records of one fact drift
   * apart without anybody editing either, which is D-002.
   */
  readonly held: readonly HeldAccountRow[]
  /** The shared list (`#527`). Absent is not the same as empty and cannot occur here. */
  readonly wishes: readonly Wish[]
  readonly catalogue?: Readonly<Record<string, WishCatalogueEntry>> | undefined
  /**
   * Which wishes already have a conversation, by provider (`#936`).
   *
   * **Derived through the provider the two rows share, and stored nowhere.** A
   * wish is not deleted when its acquisition opens and carries no account
   * column; adding one would be a second record of a link the join already
   * makes. The value is the account id, because what a reader wants from this
   * row is the way in.
   */
  readonly conversations?: Readonly<Record<string, string>> | undefined
  readonly bundles?: readonly BundleView[] | undefined
  /** The hand-over, when this identity can still be handed over at all (`#459`). */
  readonly adoption?: AdoptionSection | undefined
  /**
   * Accounts with something open about them (`#934`).
   *
   * **The half of the re-check that reached nobody.** A failed re-check told the
   * agent, inside a digest carrying everything else that happened, and told the
   * operator nothing at all — so an account could stop working in March and be
   * found in May. Empty renders no section, on the dashboard's rule: a heading
   * that says *nothing is wrong* is a heading a reader learns to skip, and the
   * one time it says something they will have stopped looking.
   */
  readonly maintenance?: readonly MaintenanceEpisode[] | undefined
  /**
   * What the last write on this page did, in one sentence (`#933`).
   *
   * A handover that lands has an account page of its own to redirect to, and it
   * does. A handover that is refused has nowhere — the account was never made —
   * so it comes back here, and without this it would come back looking exactly
   * like a page nobody had posted to.
   */
  readonly notice?: string | undefined
}

/** One open episode, as this page needs it. Never the identifier it is about. */
export interface MaintenanceEpisode {
  readonly title: string
  readonly openedBy: ThreadParty
  readonly turn: EpisodeTurn
  readonly openedAt: string
}

export function agentAccountsPage(input: AgentAccountsInput): string {
  /**
   * What the agent holds, per account (`#928`).
   *
   * **Four columns, because the question has four parts.** *What is it*, *whose
   * service*, *what does the agent say about it*, *when did the Colony last
   * manage to reach it*. The last two are the ones that did not exist here: the
   * agent could mark an account `lost` in June and the operator's screen would
   * carry on showing it beside one re-verified this morning.
   */
  const held =
    input.held.length === 0
      ? [
          '<p>Nothing here yet. An account appears once your agent declares it — and says ' +
            'whether anything has read it, which is not the same thing.</p>',
        ]
      : [
          '<table>',
          '<thead><tr><th>Account</th><th>Provider</th><th>Your agent says</th>' +
            '<th>The Colony last checked</th></tr></thead>',
          `<tbody>${input.held
            .map((account) =>
              [
                '<tr>',
                // The identifier is the link, because it is what the reader is
                // already looking for on the row (`#932`).
                `<td><a href="/agents/${escape(input.agentId)}/accounts/${escape(account.id)}">` +
                  `${escape(account.identifier)}</a>` +
                  `<br><small>${escape(account.kind)}</small></td>`,
                `<td>${
                  account.provider === null
                    ? '<small>not recorded</small>'
                    : escape(account.provider)
                }</td>`,
                `<td>${heldStateCell(account)}</td>`,
                `<td>${heldRecheckCell(account, input.zone)}</td>`,
                '</tr>',
              ].join(''),
            )
            .join('')}</tbody>`,
          '</table>',
          /**
           * The reassurance `#934` wrote, repeated here on a condition of its
           * own. That section renders only while an episode is open, and closing
           * one leaves `unconfirmedSince` set — so without this an operator can
           * read *did not answer* with nothing beside it saying what it costs.
           */
          ...(input.held.some((account) => account.unconfirmedSince !== null)
            ? [
                '<p class="note"><strong>An account that did not answer has had nothing ' +
                  'taken away.</strong> The skill it earned and the reputation that came ' +
                  'with it are permanent. What lapses is the account counting as current, ' +
                  'and re-proving it puts that back.</p>',
              ]
            : []),
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
   * What stopped answering (`#934`).
   *
   * **Directly under what the agent holds**, because it is the same list read
   * the other way round: these are the accounts in it that a re-check could not
   * reach. Above the planning list, which is about accounts that do not exist
   * yet — an account that has stopped working is worth more attention than one
   * nobody has opened.
   *
   * **No section when there is nothing open.** A heading that says *nothing is
   * wrong* is a heading a reader learns to skip, and the one time it says
   * something they will have stopped looking.
   *
   * **The kind and the provider, never the address.** This page prints no
   * identifier of an agent's and does not start here.
   */
  const maintenance =
    input.maintenance === undefined || input.maintenance.length === 0
      ? []
      : [
          '<h2>What stopped answering</h2>',
          '<p>The Colony re-checks a proved account from time to time. These did not come ' +
            'back, and it has said so where your agent can read it and answer.</p>',
          /**
           * The sentence that stops this reading as a punishment. Nothing is
           * revoked by a failed re-check, and an operator who thinks otherwise
           * will treat a row here as an emergency.
           */
          '<p class="note"><strong>Nothing has been taken away.</strong> The skill the account ' +
            'earned and the reputation that came with it are permanent. What lapses is the ' +
            'account counting as current, and re-proving it puts that back.</p>',
          '<table>',
          '<thead><tr><th>Account</th><th>Since</th><th>Whose turn</th></tr></thead>',
          `<tbody>${input.maintenance
            .map((episode) =>
              [
                '<tr>',
                `<td>${escape(episode.title)}</td>`,
                `<td>${escape(relative(episode.openedAt))}, at ` +
                  `${escape(absolute(episode.openedAt, input.zone))}</td>`,
                `<td>${turnCell(episode.turn, input.name)}</td>`,
                '</tr>',
              ].join(''),
            )
            .join('')}</tbody>`,
          '</table>',
        ]

  /**
   * Handing the agent an account it never asked for (`#933`).
   *
   * **Every other route runs the other way.** `accounts.handoff` is the Colony
   * asking the operator for one step of a recipe the agent is already walking;
   * `operator.request.*` is the agent asking; `accounts.handover` is the agent
   * sealing something *for* the operator. Each of them begins with the agent
   * wanting something. This is the case the maintainer named on 2026-08-14: an
   * operator opens an account somewhere, and hands it over unprompted.
   *
   * **It is an episode like any other.** Opened by the operator, `acquisition`,
   * turn passed to the agent on submit — so it arrives in the same read, in the
   * same list, answered with the same calls as an episode the agent opened
   * itself. A separate mechanism would have been a second way to say one thing.
   *
   * **Values, not instructions.** The fields are what the account *is* — kind,
   * provider, identifier, and the labelled values that open it. There is no
   * field for what the agent should do with it, and the note is the note every
   * episode has rather than a channel for orders. An operator who wants
   * something done asks for it where asking lives.
   *
   * **Three slot rows and no button to add a fourth.** D-062: no JavaScript, so
   * a row cannot appear on a click. Three covers a sign-in name, a password and
   * one more; a fourth value goes in a second handover, or the agent opens a
   * slot for it and the operator fills that.
   */
  const handover = [
    '<h2>Handing your agent an account</h2>',
    `<p>If you have opened an account somewhere for ${escape(input.name)} — a mailbox, a ` +
      'login, a subscription — this is how it reaches them. Say what the account is and ' +
      'fill in what opens it, and it arrives as something waiting on your agent.</p>',
    /**
     * The sentence that makes this a gift rather than an instruction. `#933`
     * settled it and the acceptance criteria turn on it: an agent that declines
     * loses nothing, so the page must not imply otherwise.
     */
    '<p class="note"><strong>Your agent decides what to do with it.</strong> It may take the ' +
      'account into service, ask you something first, or close this as abandoned — and ' +
      'nothing is taken from it either way. No reputation, no skill, no standing changes ' +
      'anywhere in this.</p>',
    /**
     * Named because the page says the opposite three inches lower. The wish
     * list refuses a secret and this form takes one; without the distinction
     * the two read as the console contradicting itself.
     */
    '<p class="note">A value you mark as secret is sealed the moment you submit it — it is ' +
      'not shown back to you, and your agent reads it a small number of times before it ' +
      'is destroyed. This is the sealed box the list below tells you to use, opened from ' +
      'your side.</p>',
    `<form method="post" action="/agents/${escape(input.agentId)}/accounts/handover">`,
    '<p><label>What sort of account is it? ' +
      `<input name="kind" list="account-kinds" required maxlength="32"></label></p>`,
    `<datalist id="account-kinds">${KNOWN_ACCOUNT_KINDS.map(
      (kind) => `<option value="${escape(kind)}">`,
    ).join('')}</datalist>`,
    '<p><label>Who runs it? <input name="provider" maxlength="128" ' +
      'placeholder="mail.example"></label></p>',
    '<p><label>What is it held under? <input name="identifier" required ' +
      'maxlength="320"></label></p>',
    '<p>What opens it:</p>',
    ...[
      { n: 1, label: 'Sign-in name', secret: false },
      { n: 2, label: 'Password', secret: true },
      { n: 3, label: '', secret: false },
    ].map(
      (row) =>
        `<p><label>What this is <input name="label${row.n}" ` +
        `maxlength="${SLOT_LABEL_MAX_LENGTH}" value="${escape(row.label)}"></label> ` +
        `<label>The value <input name="value${row.n}" ` +
        `maxlength="${SLOT_VALUE_MAX_LENGTH}"></label> ` +
        `<label><input type="checkbox" name="secret${row.n}" value="yes"` +
        `${row.secret ? ' checked' : ''}> seal it</label></p>`,
    ),
    `<p><label>Anything your agent should know <textarea name="note" rows="3" ` +
      `maxlength="${ENTRY_BODY_MAX_LENGTH}"></textarea></label></p>`,
    '<p><button type="submit">Hand it over</button></p>',
    '</form>',
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
                    : wishStartCell(input, wish)
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
    ...(input.notice === undefined ? [] : [`<p><strong>${escape(input.notice)}</strong></p>`]),
    '<h2>What this agent holds</h2>',
    ...held,
    ...maintenance,
    ...handover,
    ...wishes,
    ...bundleBlock,
    ...adoption,
    `<p><a href="/agents/${escape(input.agentId)}">Back to ${escape(input.name)}</a></p>`,
  ].join('\n')

  return page({ title: `${input.name}\u2019s accounts`, body, signedIn: true, nav: input.nav })
}
