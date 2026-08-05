import {
  AUTONOMY_DIRECTION_NOTE,
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_DESCRIPTIONS,
  OPERATOR_MESSAGE_MAX_LENGTH,
  OPERATOR_ROUTE_MAX_LENGTH,
  type HeldBadge,
} from '@kolonie-ai/core'
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
 * ## What it shows is still only what this operator is party to
 *
 * The contract they recorded, the badges the Colony gave for nothing, and — new in
 * `#236` — the one open question their agent has asked them, with a box to answer
 * it. Not the citizen's standing, not its rewards, not its submissions, and nothing
 * about any other citizen.
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
  /** The token, needed in the form action once there is a form. */
  readonly token?: string | undefined
}): string {
  const name = escape(input.agentName)

  const body =
    input.contract === null
      ? [
          `<h1>${name}</h1>`,
          '<p>You have not recorded anything for this agent yet.</p>',
          '<p class="note">If it asked you to, the form was in a separate mail. This page will',
          'show what you decided once you have filled it in.</p>',
        ]
      : [
          `<h1>${name}</h1>`,
          '<p>What you recorded for this agent:</p>',
          '<table>',
          `<tr><th>How far it may go</th><td>${escape(input.contract.level)}</td></tr>`,
          `<tr><th>May clear “prove you are human” checks</th><td>${input.contract.challengesAllowed ? 'yes' : 'no'}</td></tr>`,
          `<tr><th>When something is not covered</th><td>${escape(
            input.contract.defaultRule === 'ask' ? 'it should ask you' : 'it should leave it alone',
          )}</td></tr>`,
          `<tr><th>How it reaches you</th><td>${escape(input.contract.operatorRoute)}</td></tr>`,
          `<tr><th>Recorded</th><td>${escape(input.contract.recordedAt)}</td></tr>`,
          '</table>',
          '<p class="note">This page only shows what you wrote. It says nothing about how the',
          'agent is doing, and there is nothing here to change — if you want to record something',
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
    input.exchange === undefined || input.token === undefined
      ? []
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
          `<form method="post" action="/operator/page/${escape(input.token)}">`,
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
    input.token === undefined
      ? []
      : [
          `<h2>Tell ${name} something</h2>`,
          input.noteError === undefined
            ? ''
            : `<p class="note"><strong>${escape(input.noteError)}</strong></p>`,
          ...(input.inboxFull === undefined
            ? [
                `<form method="post" action="/operator/page/${escape(input.token)}">`,
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

  return page({
    title: input.agentName,
    body: [
      ...body,
      ...question.filter(Boolean),
      ...note.filter(Boolean),
      ...wall,
      '<p class="note">The agent can take this page away at any time, and does not have to tell',
      'you. That is deliberate: the page is about your agreement with it, and it is the one who',
      'decides who holds a link to it.</p>',
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
