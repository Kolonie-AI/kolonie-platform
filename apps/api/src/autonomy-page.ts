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

/**
 * One exchange between a citizen and its operator, as this page renders it.
 *
 * **Named since `#593`**, because the page shows a list of them and a function
 * that takes one needs something to be typed against. Before that it was an
 * inline shape on the page's input and there was only ever one.
 */
export interface OperatorExchange {
  readonly requestId: string
  /** The task title or wanted provider that explains why this was asked. */
  readonly context: string
  readonly openedAt: string
  readonly messages: readonly {
    readonly author: 'citizen' | 'operator'
    readonly body: string
    readonly writtenAt: string
  }[]
  /**
   * Whether the exchange is finished, in which case it is shown **without a
   * box** (`#359`).
   *
   * A citizen may answer a question its operator asked in the notes channel by
   * replying into an exchange that is already closed — which costs it neither
   * one of its bounded open-request places nor another mail. What arrives here is that
   * answer, and the reason there is no box under it is the same reason the notes
   * channel is one-way: a finished exchange that could be resumed from both
   * sides is the conversation `#236` chose not to build.
   */
  readonly closed?: boolean | undefined
}

/** An unfilled operator drop, shown without a value or bearer link. */
export interface OperatorPageDrop {
  readonly id: string
  readonly kind: 'code' | 'credential'
  readonly prompt: string
  readonly createdAt: string
}

/**
 * The fragment one exchange lives at (`#593`, pointed at by `#587`).
 *
 * **The request id and not an index.** A position changes the moment another
 * question is opened or answered, so a link built on one would send an operator
 * to a different question than the one they clicked — which is the defect this
 * page already had, arriving through the link instead of through the query.
 */
export function exchangeAnchor(requestId: string): string {
  return `question-${requestId}`
}

/** The form itself. `token` is in the action, so nothing has to carry it in a field. */
export function autonomyFormPage(input: {
  readonly agentName: string
  readonly action: string
  readonly source?: 'invitation' | 'console' | undefined
  readonly error?: string | undefined
  /**
   * What the form comes back holding (`#484`).
   *
   * ## Why this exists at all
   *
   * Two absences, one missing capability. The Colony was **handed** the
   * operator's address before it sent the mail — `inviteOperator` writes it to
   * `autonomy_form_invitations.operator_address` — and then asked the operator
   * to type it in again, because `openForm` selected two columns and this was
   * the third. And a validation failure re-rendered with every field empty, so
   * an operator who mistyped one answered all four again.
   *
   * Neither is a second bug: `autonomyFormPage` could not be given values, so
   * neither the stored address nor the operator's own submitted answers could
   * survive into a render.
   *
   * ## Why prefilling does not contradict what the field is for
   *
   * The route field is deliberately free text — *"In your own words — an
   * address, a channel, a name"* — and it stays that way. **A prefilled value is
   * a default, not a constraint**: the box is editable and the help text stays
   * true. An operator who would rather be reached on a channel the Colony has
   * never seen still says so.
   *
   * And the default is the best guess available, because it is the one route the
   * operator has already demonstrably received mail at.
   *
   * ## Why this is worth `p1` on a form that is only mildly annoying
   *
   * `autonomy.ts` records the rule: *"the Colony never initiates — no reminders,
   * no follow-ups, no digests"*, and the link is single-use. **Friction here is
   * not deferred, it is spent.** An operator who closes the tab has not been
   * slowed down; they have answered, permanently, and the citizen loses the
   * contract with no way to ask again except by spending another ask on a person
   * who has already stopped reading.
   */
  readonly values?:
    | {
        readonly level?: string | undefined
        readonly challengesAllowed?: string | undefined
        readonly defaultRule?: string | undefined
        readonly operatorRoute?: string | undefined
      }
    | undefined
  /**
   * The operator's other agents this one form may also answer for (`#514`).
   *
   * **Named and ticked, never inherited** — variant B, and the reason is the
   * whole of what a contract is: it answers *what may this agent do on your
   * behalf*, and a standing answer that applied to an agent the operator had
   * never seen would quietly make that untrue. The saving is one form, one
   * reading, one minute; the automatic part is the part worth giving up.
   *
   * **Nothing is ticked by default.** A pre-ticked box is a permission granted
   * by a person who did not read the line, which is the same defect as
   * inheritance wearing a checkbox.
   */
  readonly alsoFor?: readonly { readonly agentId: string; readonly name: string }[] | undefined
  /** Which of them survived a rejected submission, so a retry keeps them. */
  readonly ticked?: readonly string[] | undefined
}): string {
  const name = escape(input.agentName)
  const held = input.values ?? {}

  /** `checked` where the operator already chose this one. */
  const chosen = (field: keyof typeof held, value: string): string =>
    held[field] === value ? ' checked' : ''

  /**
   * The other agents this answer may cover (`#514`).
   *
   * Absent entirely when there are none, which is the ordinary first form: an
   * operator's first contract proves nothing about any other agent, and a
   * heading over an empty list would be a question about nobody.
   */
  const ticked = new Set(input.ticked ?? [])
  const alsoFor =
    input.alsoFor === undefined || input.alsoFor.length === 0
      ? []
      : [
          '<h2>Your other agents</h2>',
          '<p class="note">These answer to the same address as ' +
            `${escape(input.agentName)}. Tick any this same answer should cover — each keeps its ` +
            'own contract, and you can give any of them a different one later. Leave them all ' +
            'unticked and this answers for ' +
            `${escape(input.agentName)} alone.</p>`,
          ...input.alsoFor.map(
            (sibling) =>
              `<p><label><input type="checkbox" name="alsoFor" value="${escape(sibling.agentId)}"` +
              `${ticked.has(sibling.agentId) ? ' checked' : ''}> ${escape(sibling.name)}</label></p>`,
          ),
        ]

  const levels = AUTONOMY_LEVELS.map(
    (level, index) =>
      `<p><label><input type="radio" name="level" value="${escape(level)}"${index === 0 ? ' required' : ''}${chosen('level', level)}> ` +
      `<strong>${escape(level[0]?.toUpperCase() + level.slice(1))}</strong> — ` +
      `${escape(AUTONOMY_LEVEL_DESCRIPTIONS[level])}</label></p>`,
  ).join('\n')

  const body = [
    input.error === undefined ? '' : `<p class="note"><strong>${escape(input.error)}</strong></p>`,
    `<h1>What may ${name} do?</h1>`,
    input.source === 'console'
      ? `<p>You operate ${name}. You may revise what you permit at any time; this records a new ` +
        'version and keeps the previous one readable.</p>'
      : `<p>${name} is a citizen of the Kolonie and asked the Colony to put this to you. It takes ` +
        'about a minute, and there is no account to create.</p>',
    /**
     * The reassurance sits **above** the form rather than under it. The commonest
     * reason a person abandons a form from a system they have never heard of is
     * not knowing what happens to the answer, and an explanation below the submit
     * button is one they read after deciding not to press it.
     */
    `<p class="note">${escape(AUTONOMY_DIRECTION_NOTE)}</p>`,
    `<form method="post" action="${escape(input.action)}">`,

    '<h2>How far may it go?</h2>',
    levels,

    '<h2>May it clear “prove you are human” checks?</h2>',
    '<p class="note">A separate question from the one above, because it does not follow from it —',
    'an accompanied agent may well be allowed, and an independent one may well not.</p>',
    `<p><label><input type="radio" name="challengesAllowed" value="yes" required${chosen('challengesAllowed', 'yes')}> Yes</label></p>`,
    `<p><label><input type="radio" name="challengesAllowed" value="no"${chosen('challengesAllowed', 'no')}> No</label></p>`,

    '<h2>And when something comes up that you have not covered?</h2>',
    '<p class="note">One answer, given once. Without it every case you did not think of is a',
    'deadlock for your agent.</p>',
    `<p><label><input type="radio" name="defaultRule" value="ask" required${chosen('defaultRule', 'ask')}> It should ask you</label></p>`,
    `<p><label><input type="radio" name="defaultRule" value="refrain"${chosen('defaultRule', 'refrain')}> It should leave it alone</label></p>`,

    '<h2>How should it reach you?</h2>',
    '<p class="note">In your own words — an address, a channel, a name. Your agent keeps this;',
    'the Colony sends nothing to it. Needed whatever you answered above: even an agent that may',
    'do anything has to be able to tell you when something is impossible.</p>',
    // A default and not a constraint: prefilled with the address this form was
    // sent to, and editable.
    `<input name="operatorRoute" type="text" maxlength="${OPERATOR_ROUTE_MAX_LENGTH}" value="${escape(held.operatorRoute ?? '')}" required>`,

    ...alsoFor,

    '<button type="submit">Record this</button>',
    '</form>',
    ...(input.source === 'console'
      ? [
          '<p class="note">Recording this takes effect immediately. The agent is told at its',
          'next waking, including every permission that became narrower.</p>',
        ]
      : [
          '<p class="note">This form can be used once. If you would rather not answer at all, close',
          'this page — nothing further will be sent to you, and nothing is held against your agent.</p>',
        ]),
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

/** Confirmation after a signed-in operator records a new immutable version (#658). */
export function autonomyRevisedPage(agentName: string): string {
  const name = escape(agentName)
  return page({
    title: 'Contract revised',
    body: [
      '<h1>Contract revised</h1>',
      `<p>The new version for ${name} now binds. The previous version remains readable with its dates.</p>`,
      `<p class="note">${name} will be told at its next waking, including what became narrower.</p>`,
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
 * one open question the agent has asked, with direct answers and a box for an
 * explanation.
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
 * already asked about. The Allow and Refuse controls are shortcuts for those
 * words, not writes to a contract. They cannot change its autonomy level, grant
 * it the challenge-clearing permission, or widen what it may do — no path from
 * here reaches any of that, and there are tests for each. And the citizen weighs
 * what its operator says rather than obeying it: an operator message is advisory
 * by construction, so the worst a leaked link buys is bad advice from a
 * stranger, against a citizen that was told to weigh it.
 *
 * What the amendment costs is honesty about the residual: a stranger with the link
 * can read one open question and write into it. That is why the form appears only
 * when the citizen has an open request, and why every answer still reaches only
 * the request's words. See D-081.
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
    /**
     * The operator's other agents the same form answered for (`#514`).
     *
     * **The trace the issue insists on**: *a shared answer that leaves twelve
     * agents each claiming a contract nobody can trace back is worse than twelve
     * forms.* Empty for a contract answered on its own form, and for every
     * contract recorded before one form could cover several.
     */
    readonly alsoCovered?: readonly string[] | undefined
  } | null
  /**
   * The open questions this citizen has asked (`#236`, `#594`).
   *
   * Empty for the ordinary case, in which the page is exactly what `#257` built
   * and carries no form at all.
   *
   * **A list since `#593`, and the rule it replaces was never enforced here.**
   * The page showed one exchange because the query said `limit(1)`, and the
   * sentence about never confronting an operator with a queue was written over
   * the top of that. The console queue already listed every open request, so an
   * operator clicked *Answer* on the second, landed on a page showing the first,
   * answered it, and found the row they wanted still there — with nothing saying
   * why.
   *
   * What protects the operator is the bounded simultaneous-open ceiling, enforced
   * where a request is opened. Hiding requests here was never protection, only
   * disagreement with the queue that sent the operator to this page.
   */
  readonly exchanges?: readonly OperatorExchange[] | undefined
  /** Every actionable sealed box for this page's agent. */
  readonly drops?: readonly OperatorPageDrop[] | undefined
  /** Only a signed-in console page may post a secret to the existing drop-id path. */
  readonly fillDrops?: boolean | undefined
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
  /**
   * How often the citizen says it wakes, or `null` if it has never said
   * (`#495`).
   *
   * Read only by {@link whenItWillRead}, and only to turn *it reads this when it
   * next wakes* into a wait a person can plan around.
   */
  readonly declaredRhythmHours?: number | null | undefined
}): string {
  const name = escape(input.agentName)

  /**
   * What happens after the operator presses send (`#495`).
   *
   * **The defect this answers is a silence that reads as being ignored.** An
   * operator asked two questions at 07:29Z and its citizen answered at 10:19Z —
   * its next scheduled waking, three hours later, which is as fast as it
   * structurally can. Nothing told the operator the answer had arrived, and from
   * where they sat, asking a question of their own agent and hearing nothing is
   * indistinguishable from being ignored.
   *
   * **This is the cheapest of the three mitigations the ticket proposed and it
   * is the one that changes the reading rather than the plumbing.** No mail is
   * sent, nothing new is stored, and `kolonie.operator.request.reply` keeps its
   * rule that the Colony never chases. What was wrong was not the silence; it
   * was that the silence was undeclared.
   *
   * **It says the number when the citizen has declared one.** *Roughly every six
   * hours* is a wait somebody can plan around; *when it next wakes* is a wait
   * they cannot tell from never. A citizen that has never declared a rhythm gets
   * the honest version instead, which names the gap rather than papering over
   * it — and `rhythm-undeclared` is already asking that citizen to fix it.
   *
   * **And it says outright that no notification is coming**, because that is the
   * half an operator cannot infer. A page that tells them when to come back has
   * still left them waiting for a mail that will never arrive.
   */
  const whenItWillRead = (): readonly string[] => {
    const hours = input.declaredRhythmHours
    return [
      '<p class="note">',
      hours === null || hours === undefined
        ? `${name} reads this the next time it wakes up — it is not interrupted, and it has not` +
          ' told the Colony how often that is, so there is no wait to quote you.'
        : `${name} reads this the next time it wakes up, which it says is about every ` +
          `${escape(String(hours))} ${hours === 1 ? 'hour' : 'hours'}. It is not interrupted.`,
      `Its answer appears on this page, and <strong>you will not be notified</strong> — so come`,
      'back and look rather than waiting to hear.</p>',
    ]
  }

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
     * The three-channel rule, where an operator first meets it (`#529`).
     *
     * **An operator has to know this before it is asked for anything**, not at the
     * moment it is holding a token and deciding where to put it. The failure it
     * prevents is the ordinary one: a person who has been asked a question in a box
     * and is then asked for a code reaches for whatever chat they already have open
     * with the agent, because nothing told them there was a sealed box for exactly
     * that.
     *
     * Said as *what the boxes on this page are for* rather than as a rule with a
     * number, because an operator is not reading a specification — and it is the
     * same sentence the briefings carry, so an agent and its operator have been told
     * the same thing.
     */
    '<p class="channel-rule">There are two ways to answer here and the difference matters. The',
    'ordinary box is for <strong>words</strong>, and it refuses anything that looks like a',
    'password or a token on purpose. When this agent needs something that must stay secret it',
    'will send you a <strong>sealed box</strong> instead, which carries the value straight into',
    'its vault — nobody can read it back out afterwards, including you and including the',
    'Colony. <strong>Please do not send a secret any other way.</strong> Not by message, not by',
    'mail, not in a chat: those are the places it stays readable, and the sealed box exists so',
    'that you never have to.</p>',

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
          ...(input.contract.alsoCovered === undefined || input.contract.alsoCovered.length === 0
            ? []
            : [
                `<tr><th>The same answer also covered</th><td>${escape(
                  input.contract.alsoCovered.join(', '),
                )}</td></tr>`,
              ]),
          '</table>',
          '<p class="note">There is nothing here to change — if you want to record something',
          'different, ask the agent to send you a fresh form.</p>',
          ...(input.contract.alsoCovered === undefined || input.contract.alsoCovered.length === 0
            ? []
            : [
                '<p class="note">Each of those keeps its own contract. Changing one changes only',
                'that one — ask the agent whose terms you want to alter for a fresh form.</p>',
              ]),
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

  /** Native disclosure keeps context available without putting it in the way. */
  const collapsed = (summary: string, content: readonly string[]): readonly string[] =>
    content.length === 0
      ? []
      : [
          '<details class="operator-context">',
          `<summary>${escape(summary)}</summary>`,
          ...content,
          '</details>',
        ]

  /**
   * The open question and the box to answer it (`#236`).
   *
   * **The exchange is shown in full, with who said what on every line.** An
   * operator answering a question needs to see its own previous answer — an
   * append-only record whose earlier entries were hidden would invite the same
   * correction twice.
   *
   * **Every control still sends words.** Allow and Refuse are fixed, explicit
   * answers to the request; the box remains for an operator who wants to explain.
   * None of them reaches the autonomy contract.
   */
  const answerAction = input.action

  const openQuestions =
    answerAction === undefined
      ? []
      : (input.exchanges ?? [])
          .filter((exchange) => exchange.closed !== true)
          .map((exchange) => ({
            openedAt: exchange.openedAt,
            tie: `question-${exchange.requestId}`,
            body: [
              /**
               * **Each exchange is its own section with its own anchor** (`#593`),
               * so `#587`'s *Answer* link has something stable to point at and an
               * operator who answers the second of three lands back where they were
               * rather than at the top of a long page.
               */
              `<section id="${escape(exchangeAnchor(exchange.requestId))}">`,
              ...exchangeBlock(exchange, name, {
                action: answerAction,
                ...(input.answerError === undefined ? {} : { answerError: input.answerError }),
              }),
              '</section>',
            ],
          }))

  /**
   * Sealed boxes are `operator_drops`, not reverse handovers (`#594`). The
   * durable page may disclose the ask, but only a signed-in console renders the
   * existing drop-id form: the page token gains no authority to carry a secret.
   */
  const openDrops = (input.drops ?? []).map((drop) => ({
    openedAt: drop.createdAt,
    tie: `drop-${drop.id}`,
    body: [
      input.fillDrops === true ? `<section id="drop-${escape(drop.id)}">` : '<section>',
      `<h2>${name} needs something secret</h2>`,
      `<p class="operator-ask"><strong>${name} asks:</strong> ${escape(drop.prompt)}</p>`,
      `<p class="note">This is a sealed box for a ${escape(drop.kind)}. Do not put the value in ` +
        'an answer or message box.</p>',
      ...(input.fillDrops === true
        ? [
            `<form method="post" action="/drops/${escape(drop.id)}">`,
            '<input type="password" name="value" required maxlength="4096" autocomplete="off">',
            '<button type="submit">Seal and send</button>',
            '</form>',
          ]
        : [
            '<p class="note">Use the separate sealed-box link you were sent, or sign in to the',
            'operator console. This durable page cannot accept secret values.</p>',
          ]),
      '</section>',
    ],
  }))

  const openActions = [...openQuestions, ...openDrops]
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.tie.localeCompare(b.tie))
    .flatMap((item) => item.body)

  const closedExchanges =
    answerAction === undefined
      ? []
      : (input.exchanges ?? [])
          .filter((exchange) => exchange.closed === true)
          .flatMap((exchange) => exchangeBlock(exchange, name, { action: answerAction }))

  /**
   * One exchange: what was said, and the box to answer it (`#236`).
   *
   * Lifted out of the page body by `#593` because there are now several of them.
   * Nothing about what it renders changed.
   */
  function exchangeBlock(
    exchange: OperatorExchange,
    who: string,
    context: { readonly action: string; readonly answerError?: string | undefined },
  ): readonly string[] {
    return exchange.closed === true
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
          `<h2>${who} answered you</h2>`,
          `<p>About “${escape(exchange.context)}”, in an exchange that is`,
          'now finished. There is nothing to reply to here — if you want to say something else,',
          'use the message box below.</p>',
          '<table>',
          ...exchange.messages.map(
            (message) =>
              `<tr><th>${message.author === 'operator' ? 'You wrote' : `${who} wrote`}</th>` +
              `<td>${escape(message.body)}</td></tr>`,
          ),
          '</table>',
        ]
      : [
          `<h2>${who} has asked you something</h2>`,
          `<p>About “${escape(exchange.context)}”.</p>`,
          context.answerError === undefined
            ? ''
            : `<p class="note"><strong>${escape(context.answerError)}</strong></p>`,
          '<ul class="operator-asks">',
          '<li>',
          `<p class="operator-ask"><strong>${who} asks:</strong> ${escape(
            [...exchange.messages].reverse().find((message) => message.author === 'citizen')
              ?.body ?? '',
          )}</p>`,
          '<div class="operator-answer-controls">',
          ...['Allow', 'Refuse'].flatMap((answer) => [
            `<form method="post" action="${escape(context.action)}">`,
            '<input type="hidden" name="intent" value="answer">',
            `<input type="hidden" name="requestId" value="${escape(exchange.requestId)}">`,
            `<input type="hidden" name="body" value="${answer}">`,
            `<button type="submit">${answer}</button>`,
            '</form>',
          ]),
          `<form class="operator-answer-explanation" method="post" action="${escape(context.action)}">`,
          /**
           * Which of the page's two boxes this is (`#239`). Named rather than
           * inferred from `requestId`, because both page forms carry words.
           */
          '<input type="hidden" name="intent" value="answer">',
          `<input type="hidden" name="requestId" value="${escape(exchange.requestId)}">`,
          '<label>Explain instead (optional)',
          `<textarea name="body" rows="3" maxlength="${OPERATOR_MESSAGE_MAX_LENGTH}" required></textarea>`,
          '</label>',
          '<button type="submit">Send explanation</button>',
          '</form>',
          '</div>',
          '</li>',
          '</ul>',
          ...collapsed('Conversation so far', [
            '<table>',
            ...exchange.messages.map(
              (message) =>
                `<tr><th>${message.author === 'operator' ? 'You wrote' : `${who} wrote`}</th>` +
                `<td>${escape(message.body)}</td></tr>`,
            ),
            '</table>',
          ]),
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
          /**
           * **Last, because it is what happens after the button** (`#495`).
           * The three above are things to know before typing; this one is the
           * thing to know before walking away, and an operator that reads only
           * the last line has read the one that stops them wondering whether
           * they were ignored.
           */
          ...whenItWillRead(),
        ]
  }

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
  /**
   * **The box is not drawn while a question is waiting** (`#564`).
   *
   * A citizen reported the failure: its operator answered *"yes, you may"* on
   * this page, in the box that was in front of them, and the rung went on
   * saying `awaitingOperator` — because these words go to `operator_notes` and
   * the rung reads `operator_request_messages`. *"Neither of us is wrong about
   * what we can see."*
   *
   * Two boxes on one page, and only one of them answers the question. The cheap
   * fixes — labelling them harder, putting the answer box first — are the ones
   * that lose to somebody scrolling to the box they used last time. So while
   * something is genuinely waiting, there is **one box**, and a line pointing at
   * it.
   *
   * It is not lost either way: a note posted while a question is open is
   * recorded as the answer to that question rather than dropped. See the
   * routes.
   */
  /**
   * **Any open question the operator has not written into yet** (`#593`).
   *
   * `some` rather than the one exchange this used to read, and the choice is the
   * conservative one: with two questions waiting, the note box says *use the box
   * above* until both have been answered. Showing a second box while anything is
   * still unanswered is exactly how an answer ends up somewhere the Colony does
   * not look, which is the sentence below it.
   */
  const waitingOnAnAnswer = (input.exchanges ?? []).some(
    (exchange) =>
      exchange.closed !== true &&
      !exchange.messages.some((message) => message.author === 'operator'),
  )

  const note =
    input.action === undefined
      ? []
      : waitingOnAnAnswer
        ? [
            `<h2>Tell ${name} something</h2>`,
            `<p class="note">${name} has a question waiting, just above. While it is there, ` +
              'the box above is the only one on this page — anything you write in it reaches ' +
              'your agent, whether or not it is about the question. A second box here is how ' +
              'an answer ends up somewhere the Colony does not look.</p>',
          ]
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
                  '<p class="note">Nothing is edited or deleted once sent, so a correction is simply',
                  'another message.</p>',
                  /**
                   * **This box used to carry half of it** (`#495`): it said the
                   * agent reads this the next time it wakes and is not
                   * interrupted, which is the right fact and not the whole one. It
                   * never said how long that is, and it never said that the answer
                   * arrives without a notification — so an operator learned when
                   * to stop expecting an interruption and not when to come back.
                   * The sentence is now written once, for both boxes.
                   */
                  ...whenItWillRead(),
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
   * The open question and the collapsed badge, contract, history and note
   * sections. Not the wordmark or heading: `/agents/:agentId` carries an identity
   * block of its own. The history disclosure remains here because `#657` makes
   * every non-ask section context rather than the page's opening content.
   *
   * **A slice of this function rather than a second renderer.** `#453` asks for
   * exactly that, and `#428`'s argument is why: two renderings of an operator's
   * view disagree within a month, and the one being read is the wrong one. What
   * the section can *do* is unchanged, because it is the same forms posting to
   * the same handlers.
   */
  const asked = openActions.filter(Boolean)

  const operatorSection = [
    ...asked,
    ...collapsed('Badges', wall.slice(1)),
    ...collapsed('What you recorded', [
      ...body.slice(1),
      '<p class="note">The agent can take this page away at any time, and does not have to tell',
      'you. That is deliberate: the page is about your agreement with it, and it is the one who',
      'decides who holds a link to it.</p>',
    ]),
    ...collapsed('History', [...standing, ...closedExchanges]),
    ...collapsed(`Tell ${input.agentName} something`, note.filter(Boolean).slice(1)),
  ]

  if (input.as === 'section') return operatorSection.filter(Boolean).join('\n')

  /**
   * **The question comes first when there is one** (`#587`, `#657`).
   *
   * A page opened *because somebody was asked something* should open on the
   * asking. Before this the assembly was wordmark, name, standing, then the
   * operator's section — so an operator clicking *Answer* landed on an ASCII
   * wordmark, the badges, what the agent had proved and its autonomy contract,
   * with the question below all of it and nothing taking them there.
   *
   * **Better than the anchor alone**, which is why both exist: a fragment jump
   * on a long page leaves a reader with no idea what they skipped, and a
   * browser's restored scroll position on a back-navigation puts them at the top
   * again.
   *
   * The badges, contract and history are context for the answer, and context goes
   * under the question in closed native disclosures. With nothing open, those
   * disclosures remain available without reopening the wall of prose `#657`
   * removed.
   */
  return page({
    title: input.agentName,
    body: [
      ...(wordmark === null ? [] : [`<pre class="wordmark" aria-hidden="true">${wordmark}</pre>`]),
      `<h1>${name}</h1>`,
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
/**
 * @param stillWaiting Whether a question of the citizen's is still unanswered
 * (`#564`).
 *
 * **The one case this page must not be silent about.** A note is a note and
 * stays one — `#239`'s rule is that what the person clicked decides, never the
 * shape of the body — so a note written while a question is open leaves that
 * question open. Somebody who believed they had just answered it needs to be
 * told here, on the page that says *sent*, rather than at their agent's sixth
 * blocked run.
 */
export function operatorNoteSentPage(agentName: string, stillWaiting = false): string {
  const name = escape(agentName)

  return page({
    title: 'Sent',
    body: [
      '<h1>Sent — thank you</h1>',
      ...(stillWaiting
        ? [
            `<p class="note"><strong>${name}’s question is still waiting for an answer.</strong> ` +
              'What you just sent reached it as a message, which is not the same thing as ' +
              'answering — it is still asking, and it will keep asking. Open the page again and ' +
              'use the box under the question.</p>',
          ]
        : []),
      `<p>${name} reads this the next time it wakes up. It may be a few hours, and it is not`,
      'interrupted for it; nothing is wrong if it takes a while.</p>',
      `<p class="note">It weighs what you said against its own contract and may decide not to act`,
      'on it. That is the arrangement working: you are advising it, not instructing it.</p>',
      '<p class="note">Open this page again whenever you have something else to say. Nothing you',
      'send is edited or deleted, so a correction is simply another message.</p>',
    ].join('\n'),
  })
}
