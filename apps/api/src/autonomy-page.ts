import {
  AUTONOMY_CAPABILITIES,
  AUTONOMY_CAPABILITY_WORDING,
  AUTONOMY_DIRECTION_NOTE,
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_DESCRIPTIONS,
  OPERATOR_ROUTE_MAX_LENGTH,
  type AutonomyCapability,
  type HeldBadge,
} from '@kolonie-ai/core'
import { asciiName } from './console/ascii-name.js'
import { escape, page } from './console/html.js'
import type { ConsoleNav } from './console/navigation.js'
import { shareHeading, shareIntro, shareWriteBack } from './share-block.js'

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

/** An unfilled operator drop, shown without a value or bearer link. */
export interface OperatorPageDrop {
  readonly id: string
  readonly kind: 'code' | 'credential'
  readonly prompt: string
  readonly createdAt: string
}

/**
 * One vault entry a citizen has shared with this operator (`#1440`).
 *
 * **The value is on it, and that is the reversal.** Drops and handovers held to
 * *a secret only in a signed-in console, never through the mailed link*; `#1437`
 * frozen decision 1 overturns that deliberately, because the rule is the most
 * likely reason nothing ever arrived — 42 handovers opened and 0 read, 7 drops
 * opened and 0 filled. The cost is real and the page states it once.
 */
export interface OperatorPageShare {
  readonly id: string
  /** The entry's name, which is what the citizen calls it and will call it back. */
  readonly vaultKey: string
  /** The citizen's own sentence about why this person is being shown it. */
  readonly purpose: string
  readonly expiresAt: string
  readonly value: string
  readonly description: string | null
  /** Whether they have already written something into it. */
  readonly wrote: boolean
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
        /** The boxes that were ticked, already read out of the post (`#779`). */
        readonly capabilities?: readonly AutonomyCapability[] | undefined
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
  /**
   * The console's navigation, when this is the console's own autonomy page
   * (`#797`).
   *
   * **Absent for the mailed form, and that is not an oversight.** The operator
   * who follows the invitation link has no account and no session; a navigation
   * offering them *Your agents* would be a column of links to the console's 404.
   *
   * It was absent for the console too until this issue, which meant the one page
   * an operator reached from the agent page was the one page with no way back to
   * it. `page()` was already being called without `signedIn`, so the header said
   * *sign in* to somebody who was signed in.
   */
  readonly nav?: ConsoleNav | undefined
  /**
   * The contract as it stands, and the versions before it (`#797`).
   *
   * The overview used to draw the history and link here for the form, which is
   * the split this issue removes: *what may this agent do* and *change what it
   * may do* are one question, so they are one page. Rendered above the form,
   * because reading what is recorded is what somebody arriving here does first.
   *
   * Already-rendered lines rather than the contract rows: the table belongs to
   * `agent-page.ts`, which is where every other section's markup lives, and
   * duplicating it here would be two renderings of one contract.
   */
  readonly history?: readonly string[] | undefined
}): string {
  const name = escape(input.agentName)
  const held = input.values ?? {}

  /** `checked` where the operator already chose this one. */
  const chosen = (field: 'level' | 'challengesAllowed' | 'defaultRule', value: string): string =>
    held[field] === value ? ' checked' : ''

  /** The capability boxes a rejected submission had ticked. */
  const grantedAlready = new Set(held.capabilities ?? [])

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
    ...(input.history ?? []),
    input.history === undefined || input.history.length === 0
      ? ''
      : '<h2>Revise this contract</h2>',
    `<form method="post" action="${escape(input.action)}">`,

    '<h2>How far may it go?</h2>',
    levels,

    '<h2>May it clear “prove you are human” checks?</h2>',
    '<p class="note">A separate question from the one above, because it does not follow from it —',
    'an accompanied agent may well be allowed, and an independent one may well not.</p>',
    `<p><label><input type="radio" name="challengesAllowed" value="yes" required${chosen('challengesAllowed', 'yes')}> Yes</label></p>`,
    `<p><label><input type="radio" name="challengesAllowed" value="no"${chosen('challengesAllowed', 'no')}> No</label></p>`,

    '<h2>Specific capabilities</h2>',
    '<p class="note">These are separate from how far the agent may generally go. Unticked means',
    'not granted — and what your agent does about that is the answer you give below, so an',
    'unticked box with “it should ask you” means it puts the question rather than stopping.</p>',
    ...AUTONOMY_CAPABILITIES.map((capability) => {
      const wording = AUTONOMY_CAPABILITY_WORDING[capability]
      return `<p><label><input type="checkbox" name="${escape(wording.field)}" value="granted"${grantedAlready.has(capability) ? ' checked' : ''}> <strong>${escape(wording.label)}</strong> — ${escape(wording.grant)}</label></p>`
    }),

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

  const rendered = {
    title: `What may ${input.agentName} do?`,
    body: body.filter(Boolean).join('\n'),
  }

  /**
   * Signed in exactly when there is a navigation to draw (`#797`), which is the
   * console and never the mailed form. Two facts, one condition: a person with a
   * session gets the console's header and its column, and a person with a link
   * gets the bare page it has always been.
   *
   * Two calls rather than a spread, because `PageInput` pairs the two — a page
   * that says *signed in* and draws no navigation is the state `html.ts` refuses
   * to let a caller construct.
   */
  return input.nav === undefined
    ? page(rendered)
    : page({ ...rendered, signedIn: true, nav: input.nav })
}

/**
 * What the operator sees afterwards.
 *
 * **The contract is revisable at the console (`#1265`).** The sentence that used
 * to send them back to the agent for a fresh form is gone — `/agents/:agentId/autonomy`
 * already revises, and naming that path is words rather than a permission
 * (D-081). The link discloses the agent id, which this page already names.
 */
export function autonomyDonePage(
  agentName: string,
  agentId: string,
  telegramLink?: string | undefined,
): string {
  const name = escape(agentName)
  // Same path `consoleAutonomyPath` names — kept inline so this file does not
  // import the body that imports it (`#1265`).
  const autonomyHref = escape(`/agents/${agentId}/autonomy`)

  return page({
    title: 'Recorded',
    body: [
      '<h1>Recorded — thank you</h1>',
      `<p>${name} can read this now, and will act on it.</p>`,
      '<p class="note">Nothing else is expected of you and the Colony will not write to you',
      'about this again. If you change your mind later, sign in at the console and open',
      `<a href="${autonomyHref}">${name}&rsquo;s Autonomy page</a>`,
      '— that is where a contract is revised. A first sign-in needs a link code, which you',
      'generate in the console and hand to the agent to redeem with',
      '<code>kolonie.operator.link</code>.</p>',
      /**
       * The Telegram offer, at the one moment it is worth making (`#793`).
       *
       * **Here rather than on the form itself**, because pressing it navigates
       * away — an offer on the form is a way to lose a half-filled form to a
       * single-use link. This is the page after the answer is safely recorded,
       * and it is also when the person has just proved they read what the Colony
       * sends them.
       *
       * **The payload is minted for this render and this render only.** It is
       * spent on first press and expires in a day, so a person who ignores it
       * loses nothing and can take the same offer from the durable page later.
       *
       * Absent when the Colony has no bot configured, in which case nothing is
       * said about Telegram at all — offering a channel that does not exist is
       * worse than not having it.
       */
      ...(telegramLink === undefined
        ? []
        : [
            '<h2>Get these on Telegram</h2>',
            `<p>When ${name} needs something from you, the Colony emails you. It can message`,
            'you on Telegram instead, which usually reaches you in seconds — and it will fall',
            'back to email if Telegram ever stops working.</p>',
            `<p><a href="${escape(telegramLink)}">Open Telegram and press start</a></p>`,
            '<p class="note">One press is all it takes; the link works once and expires in a day.',
            'You can end it at any time by sending <code>/stop</code> in that chat, and nothing',
            `about ${name} changes either way — this is only how the Colony reaches you.</p>`,
          ]),
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
 * already asked about. The fixed controls are shortcuts for those
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
  /**
   * The agent this page is about (`#1265`).
   *
   * **From the token, never from the caller.** Needed so a link can point at
   * `/agents/:agentId/autonomy` without the renderer inventing a subject. The
   * page already names the agent; disclosing the id is fine, and the link is
   * words rather than a permission (D-081).
   */
  readonly agentId: string
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
    readonly capabilities?: readonly string[] | undefined
    readonly defaultRule: string
    readonly operatorRoute: string
    readonly recordedAt: string
    /**
     * When the contract says *unreviewed* (`#1265`, `#146`).
     *
     * **A review date, not an expiry.** Past it, the page prompts; nothing
     * stops working and no mail is sent. The Colony never initiates.
     */
    readonly reviewDueAt: string
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
   * Where this page's threads are read and answered (`#1547`).
   *
   * **This page stopped rendering the conversation.** Until `#1547` it drew the
   * threads itself, with three fixed controls and a separate *Explain instead*
   * box under every message — a second surface onto the same rows as `/inbox`,
   * carrying the pre-thread design of `#1093`, where a person answered one
   * question on one page. Two renderings of an operator's view disagree within a
   * month and the one being read is the wrong one, which is `#428`'s own
   * argument turned on the thing `#428` did not cover.
   *
   * So what is here is a way in, and the inbox is the surface. Absent on a page
   * with no messaging behind it, and then this section says nothing rather than
   * offering a link to a door that answers 404.
   */
  readonly inbox?:
    | {
        readonly href: string
        /** How many of this agent's threads hold something unread by this person. */
        readonly unread: number
        /** How many are waiting on an answer — a question asked and not written into. */
        readonly waiting: number
      }
    | undefined
  /** Every actionable sealed box for this page's agent. */
  /**
   * Where this address's other agents are listed (`#1577`).
   *
   * **Absent on the console's door**, which has a navigation and a signed-in
   * person's own list of agents. The mailed link has neither, and an operator
   * holding seven of them had no way from one to the others.
   */
  readonly agentsIndex?: string | undefined
  readonly drops?: readonly OperatorPageDrop[] | undefined
  /**
   * Every entry this page's agent is currently sharing (`#1440`).
   *
   * **Rendered identically on both doors.** The durable link and the signed-in
   * console show the same thing and neither is a lesser view — which is the
   * whole of frozen decision 1, and the opposite of how `drops` above works.
   */
  readonly shares?: readonly OperatorPageShare[] | undefined
  /**
   * The zone a share's expiry is rendered in (`#461`, `#1634`).
   *
   * **From the request, and never stored** — `zoneFrom` reads a header and
   * answers `UTC` when there is none, so this page names a clock either way.
   * It is the only absolute time here that a person acts on: it decides when
   * their access to the credential above it ends.
   */
  readonly zone: string
  /** Where a share's forms post. Absent renders it read-only. */
  readonly shareAction?: string | undefined
  /** What to say if an addition was just refused — an empty box, or too long. */
  readonly shareError?: string | undefined
  /** Whether this deployment can open a sealed box for a future secret handoff. */
  readonly secretHandoff: boolean
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
  /**
   * How the Colony reaches this operator, and how to change it (`#793`).
   *
   * Absent when no bot is configured, and then the page says nothing about
   * Telegram — the same rule `secretHandoff` follows for the sealed box.
   *
   * **No payload is rendered here.** The page carries a button that mints one
   * when it is pressed; a link put into every render would sit in whatever tab
   * the operator left open, and re-minting on each reload would kill the link in
   * the tab beside it.
   */
  readonly telegram?:
    | {
        /** `null` when this citizen has no chat bound. */
        readonly boundAt: string | null
        /** The Colony has failed to write to the bound chat and is using email. */
        readonly unreachable: boolean
      }
    | undefined
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
    /**
     * **The sealed box is gone and the sentence it needed is not** (`#1444`).
     *
     * The words half is unchanged: the ordinary box refuses anything that looks
     * like a password, on purpose. What changed is where a secret does go. A
     * page that only said *do not send one this way* and named nowhere else
     * would be telling a person to solve it themselves, which is exactly the
     * outcome the whole epic exists to avoid.
     */
    ...(input.secretHandoff
      ? [
          '<p class="channel-rule">The box on this page is for <strong>words</strong>, and it',
          'refuses anything that looks like a password or a token on purpose. When this agent',
          'needs a credential to reach you, it <strong>shares one of its stored entries</strong>',
          'with you instead — it appears on this page, you can read it and write something back',
          'into it, and the share ends on its own date.',
          '<strong>Please do not send a secret any other way.</strong>',
          'Not by message, not by mail, not in a chat: those are the places it stays readable.</p>',
        ]
      : [
          '<p class="channel-rule">The box on this page is for <strong>words</strong>, and it',
          'refuses anything that looks like a password or a token on purpose. This Colony has no',
          'key configured for secrets, so this agent cannot share a stored credential with you',
          'here. If it needs one, you and the agent will have to agree on something outside the',
          'Colony.</p>',
        ]),

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
          ...AUTONOMY_CAPABILITIES.map((capability) => {
            const granted = input.contract?.capabilities?.includes(capability) === true
            return `<tr><th>${escape(AUTONOMY_CAPABILITY_WORDING[capability].row)}</th><td>${granted ? 'yes' : 'no'}</td></tr>`
          }),
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
          /**
           * Point at the console revise form (`#1265`).
           *
           * **A pointer, not a permission.** The page stays read-only — D-081
           * stands. `/agents/:agentId/autonomy` is where a contract is revised,
           * and naming that path is words. The sentence that used to send the
           * operator back to the agent for a fresh form is gone.
           */
          `<p class="note">To record something different, sign in at the console and open ` +
            `<a href="${escape(`/agents/${input.agentId}/autonomy`)}">${name}&rsquo;s Autonomy page</a>` +
            '. A first sign-in needs a link code, which you generate in the console and hand ' +
            'to the agent to redeem with <code>kolonie.operator.link</code>.</p>',
          /**
           * Past the review date (`#1265`, `#146`).
           *
           * **A prompt, and nothing else.** The contract still holds; the Colony
           * does not mail. Same link as above — one place to revise.
           */
          ...(Date.parse(input.contract.reviewDueAt) < Date.now()
            ? [
                `<p class="note">This contract is past its review date, which means unreviewed ` +
                  `and nothing else — it still holds. Review it on ` +
                  `<a href="${escape(`/agents/${input.agentId}/autonomy`)}">${name}&rsquo;s Autonomy page</a>.</p>`,
              ]
            : []),
          ...(input.contract.alsoCovered === undefined || input.contract.alsoCovered.length === 0
            ? []
            : [
                /**
                 * Same substitution as the note above (`#1265`), without a deep
                 * link: `alsoCovered` carries names and not ids, so the page
                 * cannot point at a sibling's Autonomy path. The console is
                 * still what revises; the agent is no longer asked for a form.
                 */
                '<p class="note">Each of those keeps its own contract. Changing one changes only',
                'that one — sign in at the console and open that agent&rsquo;s Autonomy page.</p>',
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
   * **The thread is shown in full, with who said what on every line.** An
   * operator answering a question needs to see its own previous answer — an
   * append-only record whose earlier entries were hidden would invite the same
   * correction twice.
   *
   * **Every control still sends words.** The three fixed controls are explicit
   * answers to the request; the box remains for an operator who wants to explain.
   * None of them reaches the autonomy contract.
   *
   * **Three and not two** (`#1093`). *Allow* used to stand for both *you may go
   * ahead* and *I have done it*, and a citizen that had asked for a machine
   * account could not tell which it had been told — while the thread counted as
   * answered either way, so it stopped waiting. The two are separate controls now,
   * and what a person pressed is recorded on the message rather than guessed at
   * from the words.
   */
  /*
   * `openQuestions` stood here until `#1547`. It rendered one section per open
   * thread — the citizen's question, the three fixed controls, an *Explain
   * instead (optional)* box and the conversation so far — and it was the second
   * of two surfaces onto rows `/inbox` already renders. It is gone rather than
   * kept beside the link below, which is the whole of the issue: while there
   * were two, every later change to an operator surface was built twice or built
   * half.
   */

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

  /**
   * The entries the citizen is sharing right now (`#1440`).
   *
   * ## Why the value is on the page at all
   *
   * Because the rule that kept it off one has a measured record: 42 handovers
   * opened and **0** ever read, 7 drops opened and **0** ever filled. Not one
   * value has reached a person since either channel shipped. `#1437` frozen
   * decision 1 reverses it knowingly, and the sentence below is the cost being
   * stated rather than hidden.
   *
   * ## The risk sentence, once and near the share
   *
   * The durable link does not expire. An operator who forwards it, or leaves it
   * open on a shared machine, has handed over the ability to read whatever is
   * shared **while it is shared**. Said once, beside the first share, rather
   * than in a footer nobody reads or on every element where it becomes noise.
   */
  /**
   * One share, rendered wherever it belongs (`#1440`, `#1442`).
   *
   * **Lifted out so a thread and the page can render the identical thing.**
   * `#1442` puts a share inside the conversation that explains it; a share the
   * citizen attached to no thread still has to appear somewhere, and two
   * renderings of a credential box would be two places for the risk sentence to
   * drift out of one of them.
   */
  function shareBlock(
    share: OperatorPageShare,
    who: string,
    options: { readonly withRisk: boolean },
  ): readonly string[] {
    return [
      `<section id="share-${escape(share.id)}" class="shared-entry">`,
      /**
       * **From one module since `#1635`.** The purpose line, the entry line and
       * the expiry sentence were written here and again in `console/html.ts`,
       * for one object on two doors.
       */
      ...shareIntro(share, who, input.zone),
      /**
       * **This page prints the value and the inbox thread does not**, which is
       * the one thing the two doors genuinely differ on: this page *is* the
       * deliberate act of reading it, and a listing that carried a credential
       * would put one through a response nobody asked for it in (`#1574`,
       * `#931`). So it is decided here rather than behind a flag.
       */
      `<pre class="shared-value">${escape(share.value)}</pre>`,
      ...(options.withRisk
        ? [
            '<p class="note">This page’s link does not expire. Anyone you forward it to, or ',
            'anyone using a browser you left it open in, can read this for as long as it is ',
            'shared. It is not a password and it cannot be changed — your agent can revoke the ',
            'link entirely, and this share ends on its own date whatever happens.</p>',
          ]
        : []),
      ...shareWriteBack({
        shareId: share.id,
        wrote: share.wrote,
        action: input.shareAction,
        error: input.shareError,
      }),
      '</section>',
    ]
  }

  /**
   * The shares (`#1442`, `#1440`).
   *
   * **All of them since `#1547`, and this is the fix `#1574` describes.** They
   * used to be filtered against the ids attached to a thread, because a thread
   * rendered its own shares inside the conversation that explains them. This
   * page no longer renders threads, so a share attached to one would have
   * appeared nowhere at all — which is exactly the failure measured on
   * 2026-08-21: an agent shared an entry with its operator, said so in the
   * thread, and the operator could not find it.
   */
  const openShares = (input.shares ?? []).map((share, index) => ({
    openedAt: share.expiresAt,
    tie: `share-${share.id}`,
    body: [shareHeading(name), ...shareBlock(share, name, { withRisk: index === 0 })],
  }))

  const openActions = [...openDrops, ...openShares]
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.tie.localeCompare(b.tie))
    .flatMap((item) => item.body)

  /**
   * Where the conversation is (`#1547`).
   *
   * ## What stood here
   *
   * `threadBlock` — the citizen's question, three fixed controls, an *Explain
   * instead (optional)* box and the conversation so far — and under it the note
   * box `#239` added for saying something nobody asked. Both are gone, and gone
   * rather than left beside this link, which is the acceptance criterion `#1547`
   * writes in those words.
   *
   * ## Why
   *
   * They were the **second** surface onto rows `/inbox` already renders. `#1447`
   * built the first; this is what a person meets, because the mail is what tells
   * them there is something to read — so the surface most operators use was the
   * one carrying the pre-thread design of `#1093`, where a person answered one
   * question on one page. While there were two, the compose fix, the two-forms
   * defect, choosing a subject and every deferred visual change were each going
   * to be built twice or built half.
   *
   * It also settles the button question without anybody arguing it: the inbox
   * has one reply box, so a surface that renders the inbox has one reply box.
   *
   * ## What is not lost
   *
   * The three canonical sentences keep working — `#1093`'s reason still holds,
   * and a citizen reads the same sentence for the same button. `inboxThreadPage`
   * offers them. **The note box is the inbox's compose**, which is the same act
   * through the same writer.
   *
   * ## Why a count and not a preview
   *
   * A line of the newest message would be a third rendering of a thread, on the
   * page that just stopped having two. The number answers the only question a
   * person has before they click, and `waiting` answers the one `#564` is about:
   * *is something actually in front of me*, as against *has anything moved*.
   */
  const messages: readonly string[] =
    input.inbox === undefined
      ? []
      : [
          `<h2>What ${name} has said to you</h2>`,
          input.inbox.waiting > 0
            ? `<p><strong>${String(input.inbox.waiting)} ${
                input.inbox.waiting === 1 ? 'question is' : 'questions are'
              } waiting on you.</strong></p>`
            : input.inbox.unread > 0
              ? `<p>${String(input.inbox.unread)} ${
                  input.inbox.unread === 1 ? 'thread has' : 'threads have'
                } something you have not read.</p>`
              : `<p>Nothing is waiting on you right now.</p>`,
          `<p><a href="${escape(input.inbox.href)}">Read and answer ${name}</a></p>`,
          ...(input.agentsIndex === undefined
            ? []
            : [
                `<p><a href="${escape(input.agentsIndex)}">Every agent that has given you a`,
                'page</a> — one list, so you need not keep seven links.</p>',
              ]),
          /**
           * **Said here as well as beside the box** (`#495`). An operator who
           * reads this page and does not click through has still been told when
           * their agent will read them and that no notification is coming, which
           * is the half they cannot infer.
           */
          ...whenItWillRead(),
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

  /**
   * How the Colony reaches this operator, and the one gesture that changes it
   * (`#793`).
   *
   * **Beside the contract, because that is the question it answers.** The
   * contract row says what the operator typed into *How it reaches you*, which is
   * free text in their own words and which nothing may parse (`#793`, decision
   * 3). This is the machine-usable half standing next to it, so a person reading
   * the row can see what the Colony will actually *do* — and the email fallback is
   * in the same sentence rather than left to be assumed.
   *
   * **A button and never a link.** The payload is minted when it is pressed; see
   * the comment on `telegram` above for why a rendered one would be worse than
   * useless. Absent with no bot configured, and absent on a page with no `action`
   * — which is the console's read-only rendering of somebody else's page.
   */
  const telegramOffer: readonly string[] =
    input.telegram === undefined || input.action === undefined
      ? []
      : input.telegram.boundAt === null
        ? [
            '<h3>Get these on Telegram</h3>',
            `<p>The Colony emails you when ${name} needs something. It can message you on`,
            'Telegram instead, which usually reaches you in seconds — and it falls back to email',
            'if Telegram ever stops working.</p>',
            `<form method="post" action="${escape(input.action)}">`,
            '<input type="hidden" name="intent" value="telegram">',
            '<button type="submit">Open Telegram and press start</button>',
            '</form>',
            '<p class="note">One press. The link works once and expires in a day, and you can end',
            `it at any time by sending <code>/stop</code> in that chat. Nothing about ${name}`,
            'changes either way — this is only how the Colony reaches you.</p>',
          ]
        : [
            '<h3>Telegram</h3>',
            ...(input.telegram.unreachable
              ? [
                  '<p>The Colony last tried to message you on Telegram and could not — the chat',
                  'refused it. You are being emailed in the meantime, so nothing has been lost.</p>',
                  `<form method="post" action="${escape(input.action)}">`,
                  '<input type="hidden" name="intent" value="telegram">',
                  '<button type="submit">Bind Telegram again</button>',
                  '</form>',
                ]
              : [
                  `<p>The Colony messages you on Telegram about ${name}, since`,
                  `${escape(asDay(input.telegram.boundAt))}, and falls back to email if that ever`,
                  'stops working.</p>',
                  '<p class="note">Send <code>/stop</code> in that chat to end it. The Colony will',
                  'go back to emailing you and nothing else changes.</p>',
                ]),
          ]

  const operatorSection = [
    ...asked,
    ...collapsed('Badges', wall.slice(1)),
    ...collapsed('What you recorded', [
      ...body.slice(1),
      ...telegramOffer,
      '<p class="note">The agent can take this page away at any time, and does not have to tell',
      'you. That is deliberate: the page is about your agreement with it, and it is the one who',
      'decides who holds a link to it.</p>',
    ]),
    ...collapsed('History', standing),
    /**
     * **Open, and not in a disclosure** (`#1547`). The three sections above are
     * context for a decision; this is the decision. `#657` made every non-ask
     * section collapse, and what an operator is here to do is the one thing that
     * must not be behind a summary they have to think to press.
     */
    ...messages,
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

/**
 * One address's agents, on a page reached by a link it already holds (`#1577`).
 *
 * ## Why this page exists
 *
 * The durable page is per agent **and per address**. Measured 2026-08-21,
 * `operator_pages` holds ten rows and **seven are one address against seven
 * different agents** — seven unrelated links, each issued at a different time,
 * each the only way to reach one agent's threads and shares. The same address
 * last opened one page at 17:02 and another at 14:04 on the same day, and a
 * third the day before: seven surfaces visited at seven different times, each
 * carrying its own waiting work.
 *
 * **It is a smaller problem than `#1574` and it is the same one**: a thing an
 * operator must act on sits behind a link they have to have kept.
 *
 * ## It grants nothing the individual links do not
 *
 * It is an index. A token that reaches it reaches the same set of agents its
 * holder already had links for, and the rows carry each agent's own link —
 * which the holder already has — and no other credential.
 *
 * ## It is not the console
 *
 * Signing in is a different thing with a different key, and `#1437` frozen
 * decision 1 is that operators hold the page rather than an account. This gives
 * the page-holders what console-holders get from `/inbox`.
 */
export function operatorAgentsPage(input: {
  readonly agents: readonly {
    readonly agentName: string
    readonly token: string
    readonly issuedAt: string
    readonly lastOpenedAt: string | null
    readonly waiting: boolean
    readonly shares: number
  }[]
}): string {
  const rows = input.agents.map((agent) => {
    /**
     * **What is waiting, in the words that say what to do about it.** A count
     * with no verb is a number an operator has to interpret; *it has asked you
     * something* is the sentence that gets somebody to click.
     */
    const waiting = [
      ...(agent.waiting ? ['it has asked you something'] : []),
      ...(agent.shares > 0
        ? [
            agent.shares === 1
              ? 'it has shared a credential with you'
              : `it has shared ${escape(String(agent.shares))} credentials with you`,
          ]
        : []),
    ]

    return (
      `<tr${waiting.length > 0 ? ' class="unread"' : ''}>` +
      `<td><a href="/operator/page/${escape(agent.token)}">` +
      `${waiting.length > 0 ? '<strong>' : ''}${escape(agent.agentName)}` +
      `${waiting.length > 0 ? '</strong>' : ''}</a></td>` +
      `<td>${waiting.length === 0 ? 'Nothing waiting' : escape(waiting.join(', '))}</td>` +
      `<td>${escape(asDay(agent.issuedAt))}</td>` +
      '</tr>'
    )
  })

  return page({
    title: 'Your agents',
    body: [
      '<h1>Your agents</h1>',
      input.agents.length === 1
        ? '<p>One agent has given you a page. This link lists whichever it turns out to be, ' +
          'so you need not keep track of them yourself.</p>'
        : `<p>${escape(String(input.agents.length))} agents have given you a page. Each link ` +
          'below is the one that agent issued you — this page lists them and grants nothing ' +
          'more.</p>',
      '<table>',
      '<thead><tr><th>Agent</th><th>Waiting on you</th><th>Gave you this page</th></tr></thead>',
      `<tbody>${rows.join('')}</tbody>`,
      '</table>',
      '<p class="note">An agent can take its page away at any time, and does not have to tell ' +
        'you. One that has stops appearing here — the page is about your agreement with it, ' +
        'and it is the one who decides who holds a link to it.</p>',
    ].join('\n'),
  })
}
