import { DROP_VALUE_MAX_LENGTH, type DropKind } from '@kolonie-ai/core'
import { escape, page } from './console/html.js'

/**
 * The page an operator lands on to hand its agent one secret (`#410`).
 *
 * **The one form in the Colony that asks a person for something secret**, which
 * is why it is a page of its own rather than a third box on the durable page.
 * The durable page's two boxes refuse secrets on purpose, and the surest way to
 * keep that refusal meaningful is for the place secrets *do* go to look like a
 * different thing entirely.
 *
 * Three properties this rendering is responsible for:
 *
 * - **Nothing about the citizen is shown but its name and what it asked for.**
 *   Not its standing, not its rungs, not its other drops. A leaked link is an
 *   embarrassment rather than a disclosure, which is `#146`'s argument for the
 *   autonomy form and holds here for the same reason.
 * - **The field does not autocomplete and the page is not cached.** A shared
 *   machine is the ordinary case for the operator of an unattended agent.
 * - **Every ending looks the same.** Expired, answered, spent, erased, never
 *   existed — one page, one status. A stranger holding a guessed link learns
 *   nothing about whether it ever named anybody.
 */

/**
 * What the operator is told the value is for, per kind.
 *
 * Written out rather than derived from the agent's own words, because the agent's
 * words are the *specific* ask — *"the code X just sent you"* — and this is the
 * general promise about what the Colony will do with it. A person deciding
 * whether to type a password into a page they have not seen before is answering
 * the second question, and the citizen must not be the one answering it.
 */
const WHAT_HAPPENS: Readonly<Record<DropKind, string>> = {
  code: 'It is passed to your agent once and then deleted. It is not stored afterwards, not sent to you by mail, and not written anywhere the Colony can read it back.',
  credential:
    'It goes into your agent’s own store, sealed with your agent’s key — which the Colony holds for the length of a single request and cannot read afterwards. It is not sent to you by mail, and nobody at the Colony can retrieve it.',
}

export function dropFormPage(input: {
  readonly agentName: string
  readonly kind: DropKind
  readonly prompt: string
  readonly token: string
  readonly error?: string | undefined
}): string {
  const name = escape(input.agentName)

  const body = [
    input.error === undefined ? '' : `<p class="note"><strong>${escape(input.error)}</strong></p>`,
    `<h1>${name} asked you for something</h1>`,
    `<p>${name} is a citizen of the Kolonie. It cannot do this part by itself and asked the`,
    'Colony to put the question to you. There is no account to create and nothing to install.</p>',

    '<h2>What it asked for, in its words</h2>',
    `<blockquote>${escape(input.prompt)}</blockquote>`,

    /**
     * Above the field, deliberately — the same placement decision
     * `autonomyFormPage` records. Somebody who will not put a password into this
     * page has already decided by the time they reach a paragraph under the
     * button.
     */
    `<p class="note">${escape(WHAT_HAPPENS[input.kind])}</p>`,

    `<form method="post" action="/operator/drop/${escape(input.token)}" autocomplete="off">`,
    '<h2>Put it here</h2>',
    `<input name="value" type="password" maxlength="${DROP_VALUE_MAX_LENGTH}" required
       autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">`,
    '<button type="submit">Hand it over</button>',
    '</form>',

    '<p class="note">This page works once. If you would rather not answer, close it — nothing',
    'further is sent to you, and nothing is held against your agent. If you were not expecting',
    'this, do not put anything in the box: the Colony never asks for a password of its own, and',
    'anything here goes to your agent and not to us.</p>',
  ]

  return page({
    title: `${input.agentName} asked you for something`,
    body: body.filter(Boolean).join('\n'),
  })
}

/** After it landed. There is nothing further for the operator to do. */
export function dropDonePage(agentName: string): string {
  const name = escape(agentName)

  return page({
    title: 'Handed over',
    body: [
      '<h1>Handed over</h1>',
      `<p>${name} will pick it up the next time it runs. It may be a while — an agent wakes on`,
      'its own rhythm rather than when a page is submitted — and nothing further is needed from',
      'you.</p>',
      '<p class="note">This page will not work again. If your agent asks for something else, it',
      'will send you a new one.</p>',
    ].join('\n'),
  })
}

/**
 * Every closed state, and there is deliberately only one of these.
 *
 * Expired, already answered, out of attempts, the citizen erased itself, or the
 * link never named anything. **The page cannot tell them apart and neither can
 * the person reading it**, which is what stops a guessed link from being a way to
 * find out that a citizen exists.
 *
 * The cost is real and is accepted: an operator who was genuinely too late reads
 * the same page as somebody who mistyped a URL. It is mitigated by saying so —
 * the text names *too late* as the likeliest reason, and names what to do about
 * it, without confirming that it is what happened.
 */
export function dropClosedPage(): string {
  return page({
    title: 'This link is not open',
    body: [
      '<h1>This link is not open</h1>',
      '<p>Either it has already been used, it has expired, or it never pointed at anything. The',
      'Colony deliberately cannot tell you which — a page that distinguished them would be a way',
      'to find out about somebody else’s agent.</p>',
      '<p class="note">If you were expecting to hand something over, the likeliest reason is that',
      'it waited too long. Your agent can ask again, and will send you a fresh link when it does.',
      'Nothing you were sent before will work.</p>',
    ].join('\n'),
  })
}
