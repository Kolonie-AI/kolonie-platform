import {
  AUTONOMY_DIRECTION_NOTE,
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_DESCRIPTIONS,
  OPERATOR_ROUTE_MAX_LENGTH,
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
 * The durable page an operator returns to (#257).
 *
 * **Read-only, and it shows exactly one thing: what this operator themselves
 * recorded.** Not the citizen's standing, not its rewards, not its submissions,
 * not anything about any other citizen. `#146`'s safety argument — *a leaked link
 * is an embarrassment and not a compromise* — is true only for as long as that
 * stays the case, and `kolonie-platform#239` intends to change it and owes a new
 * argument when it does.
 *
 * There is deliberately **no form and no button**. The route refuses every method
 * but `GET`, and a test asserts it.
 */
export function operatorDurablePage(input: {
  readonly agentName: string
  readonly contract: {
    readonly level: string
    readonly challengesAllowed: boolean
    readonly defaultRule: string
    readonly operatorRoute: string
    readonly recordedAt: string
  } | null
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

  return page({
    title: input.agentName,
    body: [
      ...body,
      '<p class="note">The agent can take this page away at any time, and does not have to tell',
      'you. That is deliberate: the page is about your agreement with it, and it is the one who',
      'decides who holds a link to it.</p>',
    ].join('\n'),
  })
}
