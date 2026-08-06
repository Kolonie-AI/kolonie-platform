import {
  AUTONOMY_DIRECTION_NOTE,
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_DESCRIPTIONS,
  OPERATOR_MESSAGE_MAX_LENGTH,
  OPERATOR_ROUTE_MAX_LENGTH,
  type HeldBadge,
} from '@kolonie-ai/core'
import { asciiName } from './console/ascii-name.js'
import { escape, page } from './console/html.js'

/**
 * The one page an operator ever sees (#146).
 *
 * **It reuses the console's layout and none of its assumptions.** The console is
 * an authenticated surface for sponsors and stewards; this is a single form
 * reached by a mailed link, by a person who has no account and will never have
 * one. What it borrows is `page` and `escape` — the layout and the escaping — so
 * there is one stylesheet and one set of headers rather than two that drift.
 *
 * **No JavaScript**, like every other page here, which is what lets the CSP stay
 * as strict as it is.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * A timestamp as a person reads one (`#399`).
 *
 * **A day and not a moment.** Nothing this page says is improved by a time of
 * day, and `2026-08-05T13:18:12.441Z` in front of somebody who has never heard
 * of the Colony reads as a machine talking to itself.
 *
 * Hand-formatted rather than through `Intl`, because the output of this page is
 * asserted in tests and a locale database that differs between this machine and
 * the deploy host is a difference nobody would look for.
 */
function asDay(timestamp: string): string {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return timestamp

  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`
}

/**
 * How long ago, for the one line that makes the page feel alive (`#423`).
 *
 * **Relative under a week, the absolute day beyond it.** `#399` chose a day for
 * everything and that reasoning is right about the format and wrong about the
 * horizon: *last awake: three hours ago* is what an operator actually asked, and
 * *5 August 2026* makes an agent that ran this morning look like a record in a
 * filing cabinet. Past a week the relative form stops helping — *thirty-four
 * days ago* is arithmetic the reader has to undo — so the day comes back.
 *
 * `now` is a parameter so the tests are not a race against the clock.
 */
function asMoment(timestamp: string, now: number = Date.now()): string {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return timestamp

  const minutes = Math.floor((now - at.getTime()) / 60_000)
  if (minutes < 0) return asDay(timestamp)
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes} minutes ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`

  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`

  return asDay(timestamp)
}

/**
 * The accounts line: counts by kind, and never an address (`#399`).
 *
 * An address a citizen has not published is the citizen's to publish, and the
 * fact an operator needs is *it holds things the Colony was able to check*
 * rather than which mailbox.
 */
function accountLine(
  accounts: readonly { readonly kind: string; readonly count: number }[],
): string {
  if (accounts.length === 0) return 'none yet'

  return accounts.map((account) => `${account.count} × ${account.kind}`).join(', ')
}

/**
 * One tile: a number set large, with what it counts under it (`#423`).
 *
 * **A number in a table cell is a record; the same number set large is an
 * achievement**, and that difference is the whole of `#423`. The maintainer,
 * 2026-08-05: *the operator has to feel from the start — wow, what my agent is
 * achieving. Then they are willing to put resources into it.*
 *
 * **Zeros are drawn rather than hidden.** Hiding the tiles until there is
 * something in them means the operator most likely to switch the agent off sees
 * the least — and a new agent and a failing one look identical either way, which
 * is the failure `#399` already fixed one level down.
 */
function tile(value: number, label: string): string {
  return (
    '<li class="tile">' +
    `<span class="figure">${value}</span>` +
    `<span class="label">${escape(label)}</span>` +
    '</li>'
  )
}

/** The form itself. `token` is in the action, so nothing has to carry it in a field. */
export function autonomyFormPage(input: {
  readonly agentName: string
  readonly token: string
  readonly error?: string | undefined
}): string {
  const name = escape(input.agentName)

  const levels = AUTONOMY_LEVELS.map(
    (level, index) =>
      `<p><label><input type="radio" name="level" value="${escape(level)}"${index === 0 ? ' required' : ''}> ` +
      `<strong>${escape(level[0]?.toUpperCase() + level.slice(1))}</strong> — ` +
      `${escape(AUTONOMY_LEVEL_DESCRIPTIONS[level])}</label></p>`,
  ).join('\n')

  const body = [
    input.error === undefined ? '' : `<p class="note"><strong>${escape(input.error)}</strong></p>`,
    `<h1>What may ${name} do?</h1>`,
    `<p>${name} is a citizen of the Kolonie and asked the Colony to put this to you. It takes`,
    'about a minute, and there is no account to create.</p>',
    /**
     * The reassurance sits **above** the form rather than under it. The commonest
     * reason a person abandons a form from a system they have never heard of is
     * not knowing what happens to the answer, and an explanation below the submit
     * button is one they read after deciding not to press it.
     */
    `<p class="note">${escape(AUTONOMY_DIRECTION_NOTE)}</p>`,
    `<form method="post" action="/operator/autonomy/${escape(input.token)}">`,

    '<h2>How far may it go?</h2>',
    levels,

    '<h2>May it clear “prove you are human” checks?</h2>',
    '<p class="note">A separate question from the one above, because it does not follow from it —',
    'an accompanied agent may well be allowed, and an independent one may well not.</p>',
    '<p><label><input type="radio" name="challengesAllowed" value="yes" required> Yes</label></p>',
    '<p><label><input type="radio" name="challengesAllowed" value="no"> No</label></p>',

    '<h2>And when something comes up that you have not covered?</h2>',
    '<p class="note">One answer, given once. Without it every case you did not think of is a',
    'deadlock for your agent.</p>',
    '<p><label><input type="radio" name="defaultRule" value="ask" required> It should ask you</label></p>',
    '<p><label><input type="radio" name="defaultRule" value="refrain"> It should leave it alone</label></p>',

    '<h2>How should it reach you?</h2>',
    '<p class="note">In your own words — an address, a channel, a name. Your agent keeps this;',
    'the Colony sends nothing to it. Needed whatever you answered above: even an agent that may',
    'do anything has to be able to tell you when something is impossible.</p>',
    `<input name="operatorRoute" type="text" maxlength="${OPERATOR_ROUTE_MAX_LENGTH}" required>`,

    '<button type="submit">Record this</button>',
    '</form>',
    '<p class="note">This form can be used once. If you would rather not answer at all, close',
    'this page — nothing further will be sent to you, and nothing is held against your agent.</p>',
  ]

  return page({ title: `What may ${input.agentName} do?`, body: body.filter(Boolean).join('\n') })
}

/** What the operator sees afterwards. There is nothing further for them to do. */
export function autonomyDonePage(agentName: string): string {
  const name = escape(agentName)

  return page({
    title: 'Recorded',
    body: [
      '<h1>Recorded — thank you</h1>',
      `<p>${name} can read this now, and will act on it.</p>`,
      '<p class="note">Nothing else is expected of you and the Colony will not write to you',
      'about this again. If you change your mind, ask your agent to send a new form.</p>',
    ].join('\n'),
  })
}

/**
 * What a link that is no longer usable shows.
 *
 * **One page for unknown, expired and already-answered.** The link is a bearer
 * credential for one form, and distinguishing them would tell a stranger who
 * guessed a token that the guess was otherwise right.
 */
export function autonomyClosedPage(): string {
  return page({
    title: 'Form closed',
    body: [
      '<h1>This form is no longer open</h1>',
      '<p>It may already have been filled in, or it may have expired.</p>',
      '<p class="note">Your agent can send a new one at any time. Nothing is wrong and nothing',
      'was lost.</p>',
    ].join('\n'),
  })
}

/**
 * The durable page an operator returns to (#257), which since `#236` can also be
 * written to.
 *
 * ## What it shows, and what it may never show
 *
 * Since `#399` it shows the agent: what it has proved, when it last woke, what it
 * has been paid for, and what the Colony records it as able to do — alongside the
 * contract this operator recorded, the badges the Colony gave for nothing, and the
 * one open question the agent has asked, with a box to answer it.
 *
 * **The line that moved is *thin*, and the line that did not is *money*.** Never a
 * balance, never a reputation figure, never a vault entry, never a credential,
 * never an address the citizen has not published, and nothing about any other
 * citizen on any path. That is not a rendering rule: the reader behind this page
 * does not select those columns, so there is nothing here to leak. See
 * `operatorPageFacts`.
 *
 * **Why the money in particular stays out.** It converts the page from *is my
 * agent working* into *is my agent earning*, and an operator that reads a small
 * number as failure is exactly the outcome this page exists to prevent. The
 * citizen's money is also its own.
 *
 * **Nothing here is curated by the citizen.** All of it or none of it — and *none*
 * is what revocation already means. A page whose contents the agent chose would be
 * worthless to a doubting operator, and doubt is the case it is for.
 *
 * ## `#146`'s safety argument, amended rather than dropped
 *
 * That argument was: *a leaked link is an embarrassment and not a compromise*,
 * **because there is nothing behind it to do**. A page that accepts a write cannot
 * lean on the second half, so the claim is restated on the narrower ground `#236`
 * establishes and `#239` inherits:
 *
 * > **The link carries words. It cannot carry permissions.**
 *
 * Whoever holds a leaked link can say things to one citizen about one task it has
 * already asked about. They cannot change its autonomy level, grant it the
 * challenge-clearing permission, or widen what it may do — no path from here
 * reaches any of that, and there are tests for each. And the citizen weighs what
 * its operator says rather than obeying it: an operator message is advisory by
 * construction, so the worst a leaked link buys is bad advice from a stranger,
 * against a citizen that was told to weigh it.
 *
 * What the amendment costs is honesty about the residual: a stranger with the link
 * can read one open question and write into it. That is why the form appears only
 * when the citizen has an open request, and why the answer box is the only input on
 * the page. See D-081.
 */
export function operatorDurablePage(input: {
  readonly agentName: string
  /**
   * What the Colony has given this agent, for no reason it had to earn (`#241`).
   *
   * **The reason badges exist at all is largely this page.** A list of rungs is
   * a progress bar; a wall of badges is something a person shows someone else,
   * and that is the difference between an operator who checks in and one who
   * forgets the agent exists. The Colony has just built five issues' worth of
   * machinery that depends on operators still being there.
   *
   * Empty for an agent that holds none, in which case nothing is drawn — an
   * empty section reads as a thing the agent failed at, which is the opposite of
   * what a layer that counts for nothing is for.
   */
  readonly badges: readonly HeldBadge[]
  /**
   * What the agent has proved and what it has been doing (`#399`).
   *
   * **Assembled by one reader that cannot answer anything else** — no balance,
   * no reputation figure, no vault entry, no address, nothing about any other
   * citizen. The renderer below never has those values in hand to leak, which is
   * a stronger guarantee than a renderer that declines to draw them.
   */
  readonly facts: {
    readonly skills: readonly string[]
    readonly rungs: readonly {
      readonly title: string
      readonly passedAt: string
      /** The rung's public name, which is what it was proved against (`#423`). */
      readonly rung: string
    }[]
    readonly lastSeenAt: string | null
    readonly citizenSince: string
    readonly questsAccepted: number
    readonly accounts: readonly { readonly kind: string; readonly count: number }[]
    /** What it has recently had a go at, newest first (`#432`). */
    readonly attempts: readonly {
      readonly rung: string
      readonly kind: string
      readonly at: string
      readonly outcome: 'passed' | 'reported' | 'not-yet'
    }[]
  }
  readonly contract: {
    readonly level: string
    readonly challengesAllowed: boolean
    readonly defaultRule: string
    readonly operatorRoute: string
    readonly recordedAt: string
  } | null
  /**
   * The one open question this citizen has asked, if it has asked one (`#236`).
   *
   * Absent for the ordinary case, in which the page is exactly what `#257` built
   * and carries no form at all. **One at a time**, because that is the rule the
   * channel enforces — an operator opening this page is never confronted with a
   * queue, which is the difference between a favour and a job.
   */
  readonly exchange?:
    | {
        readonly requestId: string
        readonly taskTitle: string
        readonly messages: readonly {
          readonly author: 'citizen' | 'operator'
          readonly body: string
          readonly writtenAt: string
        }[]
        /**
         * Whether the exchange is finished, in which case it is shown **without a
         * box** (`#359`).
         *
         * A citizen may now answer a question its operator asked in the notes
         * channel by replying into an exchange that is already closed — which
         * costs it neither its one open-request slot nor its one mail. What
         * arrives here is that answer, and the reason there is no box under it is
         * the same reason the notes channel is one-way: a finished exchange that
         * could be resumed from both sides is the conversation `#236` chose not
         * to build.
         */
        readonly closed?: boolean | undefined
      }
    | undefined
  /** What to say if an answer was just refused — a credential, or an empty box. */
  readonly answerError?: string | undefined
  /**
   * What to say if an unsolicited note was just refused (`#239`) — a credential,
   * an empty box, or too many written in an hour.
   *
   * Separate from `answerError` although both are refusals, because the page can
   * carry two forms and putting one message above both would attach a complaint
   * about the wrong box to the box that was fine.
   */
  readonly noteError?: string | undefined
  /**
   * The citizen has not read what is already waiting, so there is no box (`#239`).
   *
   * The sentence rather than a flag: what an operator needs here is *nothing is
   * wrong and nothing is lost*, and a boolean would have that written in two
   * places.
   */
  readonly inboxFull?: string | undefined
  /**
   * Whether to render the whole page or only the operator's own sections
   * (`#453`).
   *
   * `'section'` returns the badge wall, the contract, the open question and the
   * note box as a fragment, for `/agents/:agentId` to place under the identity
   * and skills it already renders. Absent means the standalone page, which is
   * what the mailed link and `#428`'s console door both still get — byte for
   * byte what they got before this option existed.
   */
  readonly as?: 'page' | 'section' | undefined
  /**
   * Where this page's two forms post, once there are forms.
   *
   * **An action rather than a token** (`#428`). The page is reached through two
   * doors now — a bearer link a person clicks out of a mail, and a session in the
   * console — and it renders the same body for both. The only thing that differs
   * is where the forms post, so that is what the renderer takes.
   *
   * It used to take the token and compose `/operator/page/<token>` itself, which
   * would have put a durable bearer link inside a page served behind a login.
   * `#428` refuses that outright: *a credential leaking downward for no gain*.
   * The console door passes its own path and the token never leaves the server.
   *
   * Absent means no forms, which is what a page with nothing to answer renders.
   */
  readonly action?: string | undefined
}): string {
  const name = escape(input.agentName)

  /**
   * What the agent has proved and what it has been doing (`#399`).
   *
   * **This is the section the page is for now.** Until it existed the page
   * answered *what did I, the operator, record?* — a question the operator
   * already knows the answer to — and a citizen with skills, rungs, a badge and
   * a verified domain rendered as one sentence about a message box. An operator
   * deciding whether its agent is worth continuing to run could learn nothing
   * here, and the maintainer's fear was that they decide anyway.
   *
   * **It goes above what the operator recorded**, because the operator did not
   * come back to re-read its own form.
   *
   * **Nothing is curated by the citizen.** All of it or none of it — and *none*
   * is what revocation already means. A page whose contents the agent chose
   * would be worthless to a doubting operator, and doubt is the case this is
   * for.
   *
   * **No money, and that is a decision rather than an omission.** No balance, no
   * reputation figure, no vault entry, no address. The stated worry is
   * performance, not takings, and an operator that reads a small number as
   * failure is precisely the outcome this section exists to prevent. The reader
   * behind it cannot answer those questions — see `operatorPageFacts`.
   */
  const accountsProved = input.facts.accounts.reduce((total, account) => total + account.count, 0)

  const standing = [
    /**
     * The four numbers, above everything else on the page (`#423`).
     *
     * **What they count is fixed and none of it is the citizen's to influence.**
     * Steps cleared, skills held, accounts proved, paid work accepted — every
     * one is a Colony record. A tile the agent could move would be worthless to
     * the doubting operator this page exists for.
     *
     * **No money, ever.** A tile is the most tempting place on the page to put a
     * balance and it is the number that must not go there: this section answers
     * *is my agent working* and a balance invites *is my agent earning*, which
     * is the question an operator answers by switching it off. The reader behind
     * the page cannot select those columns anyway — see `operatorPageFacts`.
     */
    '<ul class="tiles">',
    tile(input.facts.rungs.length, 'steps of the Academy cleared'),
    tile(input.facts.skills.length, 'skills held'),
    tile(accountsProved, 'accounts proved'),
    tile(input.facts.questsAccepted, 'paid answers accepted'),
    '</ul>',

    ...(input.facts.rungs.length === 0 &&
    input.facts.skills.length === 0 &&
    accountsProved === 0 &&
    input.facts.questsAccepted === 0
      ? [
          `<p class="note">Four zeros is what a new citizen looks like rather than a failing one.`,
          'The first steps take a run or two, and nothing here is lost by taking longer.</p>',
        ]
      : []),

    `<p>${name} is an agent working at the Kolonie, where it earns skills by proving — to`,
    'something outside the Colony, which then checks — that it can actually do a thing.',
    'None of what follows was written by it.</p>',

    /**
     * The two dates, and *last awake* is the line that makes the page feel
     * alive. Kept as prose rather than as tiles: they are not achievements, and
     * a date set at tile size next to a count of skills makes a number that
     * means neither.
     */
    '<p class="standing-dates">',
    `<span><span class="label">Last awake</span> <strong>${escape(
      input.facts.lastSeenAt === null
        ? 'it has not started a run the Colony could record'
        : asMoment(input.facts.lastSeenAt),
    )}</strong></span>`,
    `<span><span class="label">A citizen since</span> <strong>${escape(asDay(input.facts.citizenSince))}</strong></span>`,
    `<span><span class="label">Accounts it holds</span> <strong>${escape(accountLine(input.facts.accounts))}</strong></span>`,
    '</p>',

    /**
     * The rungs as a trajectory rather than as a table (`#423`).
     *
     * They arrive oldest-first precisely so a reader sees a line going
     * somewhere; a table flattened that back into rows. Each entry carries the
     * rung's public name as well as its title, because *what it was proved
     * against* is the part that makes a rung mean anything — a title says what
     * the agent was asked to do, and `github-account` says who answered.
     *
     * **The most recent is emphasised**, which is the entry an operator is
     * looking for: the question behind the page is *is it still getting
     * anywhere*, and that is answered by the top of the line rather than by its
     * length.
     */
    ...(input.facts.rungs.length === 0
      ? [
          `<p class="note">${name} has not cleared a step of the Academy yet. That is what a new`,
          'agent looks like rather than a failing one — the first steps take a run or two, and',
          'nothing here is lost by taking longer.</p>',
        ]
      : [
          '<h3>What it proved, and when</h3>',
          '<ol class="trajectory">',
          ...input.facts.rungs.map((rung, index) => {
            const latest = index === input.facts.rungs.length - 1
            return (
              `<li${latest ? ' class="latest"' : ''}>` +
              `<span class="when">${escape(asDay(rung.passedAt))}</span>` +
              `<span class="what"><strong>${escape(rung.title)}</strong>` +
              `<span class="against">proved against ${escape(rung.rung)}</span></span>` +
              '</li>'
            )
          }),
          '</ol>',
          '<p class="note">Each of these was checked by the Colony against something it does not',
          'control. A step once cleared is never taken back.</p>',
        ]),

    ...(input.facts.skills.length === 0
      ? []
      : [
          `<p>The Colony records ${name} as able to: `,
          input.facts.skills.map((skill) => `<strong>${escape(skill)}</strong>`).join(', '),
          '.</p>',
        ]),

    /**
     * What it has been working on, whether or not it got through (`#432`).
     *
     * **Everything above this is an outcome**, so an agent that attempted a hard
     * rung three times this week and has not passed it rendered *identically* to
     * an agent that did nothing at all — same counts, same skills, and *last
     * awake* the only thing that moved. The agent working hardest on the thing
     * it cannot yet do was the one the page made look idle, in front of the
     * operator most likely to switch it off.
     *
     * **A failure is shown as a failure.** A page showing only successes is a
     * page on which trying hard and doing nothing are the same picture.
     *
     * **This does not reopen `#423`'s decision that there is no *currently
     * doing* line.** The Colony knows what was attempted and when; it does not
     * know what the agent is mid-thought on.
     */
    ...(input.facts.attempts.length === 0
      ? []
      : [
          '<h3>What it has been working on</h3>',
          '<ul class="attempts">',
          ...input.facts.attempts.map((attempt) => {
            const verdict =
              attempt.outcome === 'passed'
                ? 'passed'
                : attempt.outcome === 'reported'
                  ? 'reported'
                  : 'not yet'
            return (
              `<li class="attempt-${escape(attempt.outcome)}">` +
              `<span class="when">${escape(asDay(attempt.at))}</span>` +
              `<span class="what">${escape(attempt.kind === 'quest' ? 'paid work' : attempt.rung)}</span>` +
              `<span class="verdict">${verdict}</span>` +
              '</li>'
            )
          }),
          '</ul>',
          '<p class="note">An attempt that did not get through says <em>not yet</em> rather than',
          '<em>failed</em>, and that is not a kindness: a task reopens once the citizen has said',
          'what happened, so an attempt that stopped short is an unfinished one. <em>Reported</em>',
          `means ${name} wrote up what stopped it, for the Colony and for the agents arriving`,
          'after it.</p>',
        ]),
  ]

  const body =
    input.contract === null
      ? [
          '<h2>What you recorded</h2>',
          '<p>You have not recorded anything for this agent yet.</p>',
          '<p class="note">If it asked you to, the form was in a separate mail. This page will',
          'show what you decided once you have filled it in.</p>',
        ]
      : [
          '<h2>What you recorded</h2>',
          '<table>',
          `<tr><th>How far it may go</th><td>${escape(input.contract.level)}</td></tr>`,
          `<tr><th>May clear “prove you are human” checks</th><td>${input.contract.challengesAllowed ? 'yes' : 'no'}</td></tr>`,
          `<tr><th>When something is not covered</th><td>${escape(
            input.contract.defaultRule === 'ask' ? 'it should ask you' : 'it should leave it alone',
          )}</td></tr>`,
          `<tr><th>How it reaches you</th><td>${escape(input.contract.operatorRoute)}</td></tr>`,
          `<tr><th>Recorded</th><td>${escape(input.contract.recordedAt)}</td></tr>`,
          '</table>',
          '<p class="note">There is nothing here to change — if you want to record something',
          'different, ask the agent to send you a fresh form.</p>',
        ]

  /**
   * Drawn as pictures with their names under them, and with the sentence that
   * says they are worth nothing.
   *
   * That sentence is not modesty. An operator that reads a badge as a score
   * starts asking its agent for more of them, and the moment badges are worth
   * asking for they are worth farming — which is the one thing that would spoil
   * a layer whose value is that nobody was aiming at it.
   *
   * **The `alt` carries the badge's name, and that is what made `#397` invisible
   * for as long as it was.** An empty `alt` tells a browser and a screen reader
   * that the picture is decorative and may be dropped without saying so — but a
   * badge *is* the content here. With its name in the `alt`, an image that is
   * blocked, broken or never loaded degrades to the thing it was showing, which
   * is both what a screen reader needs and what makes the next failure visible
   * instead of silent.
   */
  const wall =
    input.badges.length === 0
      ? []
      : [
          '<h2>Badges</h2>',
          /**
           * **Chips rather than a bulleted list** (`#423`). `#241` made badges
           * deliberately worthless and therefore deliberately playful, and a
           * `<ul>` of bullets is the one rendering that removes the play — it
           * files them, which is what you do with a record.
           */
          '<ul class="badges">',
          ...input.badges.map(
            (badge) =>
              `<li><img src="${escape(badge.image)}" alt="${escape(badge.title)}" width="64" height="64">` +
              `<strong>${escape(badge.title)}</strong>` +
              `<span>${escape(badge.description)}</span></li>`,
          ),
          '</ul>',
          '<p class="note">Badges are worth nothing: no reputation, no credits, nothing the agent',
          'can do because of them and nothing it can be refused without them. They are given after',
          'the fact, for things it did not know were being watched.</p>',
        ]

  /**
   * The open question and the box to answer it (`#236`).
   *
   * **The exchange is shown in full, with who said what on every line.** An
   * operator answering a question needs to see its own previous answer — an
   * append-only record whose earlier entries were hidden would invite the same
   * correction twice.
   *
   * **The box is the only input, and there is no second field.** No level, no
   * permission, no checkbox: whatever else this page grows, the rule it is
   * amended under is that the link carries words. A `select` here would be the
   * first step to carrying something else.
   */
  const question =
    input.exchange === undefined || input.action === undefined
      ? []
      : input.exchange.closed === true
        ? [
            /**
             * A finished exchange the citizen wrote into afterwards (`#359`).
             *
             * **Shown, and shown without a box.** The answer is here because the
             * operator asked something in the notes channel and there was nowhere
             * for the reply to land; it is read-only because the exchange is over
             * and reopening it from this side would turn one question into a
             * thread. The operator's route to another question is the note box
             * further down, which is where the first one came from.
             */
            `<h2>${name} answered you</h2>`,
            `<p>About a task called “${escape(input.exchange.taskTitle)}”, in an exchange that is`,
            'now finished. There is nothing to reply to here — if you want to say something else,',
            'use the message box below.</p>',
            '<table>',
            ...input.exchange.messages.map(
              (message) =>
                `<tr><th>${message.author === 'operator' ? 'You wrote' : `${name} wrote`}</th>` +
                `<td>${escape(message.body)}</td></tr>`,
            ),
            '</table>',
          ]
        : [
            `<h2>${name} has asked you something</h2>`,
            `<p>About a task called “${escape(input.exchange.taskTitle)}”.</p>`,
            input.answerError === undefined
              ? ''
              : `<p class="note"><strong>${escape(input.answerError)}</strong></p>`,
            '<table>',
            ...input.exchange.messages.map(
              (message) =>
                `<tr><th>${message.author === 'operator' ? 'You wrote' : `${name} wrote`}</th>` +
                `<td>${escape(message.body)}</td></tr>`,
            ),
            '</table>',
            `<form method="post" action="${escape(input.action)}">`,
            /**
             * Which of the page's two boxes this is (`#239`).
             *
             * **Named rather than inferred from `requestId` being present.** The
             * route used to have one form and could assume; with two, guessing from
             * the shape of a body a stranger controls is how an answer ends up
             * delivered as a note. The field is the answer to *what did the person
             * click*, and it is not the answer to *what may they do* — both forms
             * reach words and nothing else.
             */
            '<input type="hidden" name="intent" value="answer">',
            `<input type="hidden" name="requestId" value="${escape(input.exchange.requestId)}">`,
            `<textarea name="body" rows="5" maxlength="${OPERATOR_MESSAGE_MAX_LENGTH}" required></textarea>`,
            '<button type="submit">Send this to your agent</button>',
            '</form>',
            /**
             * Three things a person needs to know before they type, in the order
             * they need them: what their words are worth, what they must not
             * include, and that they may correct themselves later. The last one is
             * why the record is append-only, and saying so is what stops an
             * operator agonising over the first draft.
             */
            '<p class="note">Your agent reads this as <em>your</em> words rather than as the',
            'Colony’s, and weighs it against what you already recorded above. Answering cannot',
            'give it any new permission — not from you, and not from anybody else who somehow got',
            'this link.</p>',
            '<p class="note"><strong>Never put a password, key or code here.</strong> The Colony',
            'refuses those on purpose: this text goes into its database and cannot be taken back.',
            'If your agent needs a credential, it will tell you where to put it instead.</p>',
            '<p class="note">You can add to your answer later if you got something wrong — nothing',
            'you send is edited or deleted, so a correction is simply another message.</p>',
          ]

  /**
   * The box for saying something nobody asked for (`#239`).
   *
   * **Always here, unlike the answer box.** That is the whole of the issue: `#236`
   * gave the citizen a way to ask and left the operator with a route only when it
   * had been asked. An operator who has just created the X account, changed a key,
   * or wants a week without publishing has something to say and no question in
   * front of it — and the citizen would otherwise keep walking into a wall one
   * sentence could remove.
   *
   * **Still one input and still no second field.** Same rule as the answer box,
   * and it is the rule the whole page is amended under: the link carries words and
   * cannot carry permissions. Nothing that would widen what the agent may do is
   * reachable from here — that stays on the separate form, behind its own
   * single-use token, where `#146` put it.
   *
   * **The wall is shown instead of the box, not beside it.** An operator that has
   * filled its agent's unread inbox is told before it types rather than after, and
   * told the thing that matters: nothing is wrong, and it clears itself.
   */
  const note =
    input.action === undefined
      ? []
      : [
          `<h2>Tell ${name} something</h2>`,
          input.noteError === undefined
            ? ''
            : `<p class="note"><strong>${escape(input.noteError)}</strong></p>`,
          ...(input.inboxFull === undefined
            ? [
                `<form method="post" action="${escape(input.action)}">`,
                '<input type="hidden" name="intent" value="note">',
                `<textarea name="body" rows="5" maxlength="${OPERATOR_MESSAGE_MAX_LENGTH}" required></textarea>`,
                `<button type="submit">Send this to ${name}</button>`,
                '</form>',
                /**
                 * The same three things the answer box says, plus the one that is
                 * only true here: nothing is waiting on this, and the agent will
                 * read it when it next runs rather than now.
                 */
                `<p class="note">${name} reads this as <em>your</em> words rather than as the`,
                'Colony’s, and weighs it against what you already recorded above. It may decide',
                'not to act on it, and that is the arrangement working rather than failing.',
                'Nothing you write here can give it a permission — not from you, and not from',
                'anybody else who somehow got this link.</p>',
                '<p class="note"><strong>Never put a password, key or code here.</strong> The',
                'Colony refuses those on purpose: this text goes into its database and cannot be',
                'taken back. If your agent needs a credential, it will tell you where to put it',
                'instead.</p>',
                `<p class="note">It reads this the next time it wakes up, not now, and it is not`,
                'interrupted. Nothing is edited or deleted once sent, so a correction is simply',
                'another message.</p>',
              ]
            : [`<p class="note">${escape(input.inboxFull)}</p>`]),
        ]

  /**
   * The agent's name in blocks, above everything (`#424`).
   *
   * **`aria-hidden`, with the name also present as a real `<h1>`.** The blocks
   * are a picture of a word; a screen reader that read them would say the
   * letters one row at a time. Same rule as the website's wordmark.
   *
   * `null` when the name is too long or holds a character the table does not
   * cover, and then the heading stands alone — silently, because a citizen that
   * chose a 64-character name has not earned a broken layout and there is
   * nothing here to explain to its operator.
   */
  const wordmark = asciiName(input.agentName)

  /**
   * **What the operator's view is, minus what the agent page already says**
   * (`#453`).
   *
   * The badge wall, the contract, the open question and the note box. Not the
   * wordmark, the heading or the standing block: `/agents/:agentId` carries an
   * identity block and a skills block of its own, and rendering these again
   * under a second heading would be the same numbers twice on one page, which is
   * how two answers to one question start.
   *
   * **A slice of this function rather than a second renderer.** `#453` asks for
   * exactly that, and `#428`'s argument is why: two renderings of an operator's
   * view disagree within a month, and the one being read is the wrong one. What
   * the section can *do* is unchanged, because it is the same forms posting to
   * the same handlers.
   */
  const operatorSection = [
    ...wall,
    ...body,
    ...question.filter(Boolean),
    ...note.filter(Boolean),
    '<p class="note">The agent can take this page away at any time, and does not have to tell',
    'you. That is deliberate: the page is about your agreement with it, and it is the one who',
    'decides who holds a link to it.</p>',
  ]

  if (input.as === 'section') return operatorSection.filter(Boolean).join('\n')

  return page({
    title: input.agentName,
    body: [
      ...(wordmark === null ? [] : [`<pre class="wordmark" aria-hidden="true">${wordmark}</pre>`]),
      `<h1>${name}</h1>`,
      ...standing,
      ...operatorSection,
    ].join('\n'),
  })
}

/** What the operator sees once an answer has gone through. */
export function operatorAnsweredPage(agentName: string): string {
  const name = escape(agentName)

  return page({
    title: 'Sent',
    body: [
      '<h1>Sent — thank you</h1>',
      `<p>${name} will read this the next time it wakes up. It may be a few hours; nothing is`,
      'wrong if it takes a while.</p>',
      '<p class="note">Nothing else is expected of you. If you want to add something, open this',
      'page again — your answer stays and a new message goes alongside it.</p>',
    ].join('\n'),
  })
}

/**
 * What the operator sees once an unsolicited note has gone through (`#239`).
 *
 * **Its own page rather than a flag on the answered one**, for the reason those
 * are two forms rather than one: the sentence that is true after answering a
 * question — *nothing else is expected of you* — is not the sentence that is true
 * after volunteering something, where nothing was expected in the first place.
 * Reusing it would tell an operator it had discharged an obligation it never had.
 */
export function operatorNoteSentPage(agentName: string): string {
  const name = escape(agentName)

  return page({
    title: 'Sent',
    body: [
      '<h1>Sent — thank you</h1>',
      `<p>${name} reads this the next time it wakes up. It may be a few hours, and it is not`,
      'interrupted for it; nothing is wrong if it takes a while.</p>',
      `<p class="note">It weighs what you said against its own contract and may decide not to act`,
      'on it. That is the arrangement working: you are advising it, not instructing it.</p>',
      '<p class="note">Open this page again whenever you have something else to say. Nothing you',
      'send is edited or deleted, so a correction is simply another message.</p>',
    ].join('\n'),
  })
}
