import {
  acceptShare,
  closeShare,
  latestShare,
  liveShare,
  offerShare,
  shareForToken,
  shareForWakeup,
  shareOfferedTo,
  type AcceptShareOutcome,
  type Database,
  type OfferRefusal,
  type OfferShareCommand,
  type OfferShareOutcome,
  type ShareForRelay,
  type WaitingShare,
} from '@kolonie-ai/db'
import {
  BROWSER_SHARE_LIVE_MINUTES,
  BROWSER_SHARE_OFFER_HOURS,
  BROWSER_SHARE_SKILL,
  type AgentId,
  type ApiError,
  type HumanId,
  type Log,
  type ShareCloseReason,
  type ShareSummary,
} from '@kolonie-ai/core'
import type { OperatorMailer } from './email.js'
import type { OutboundAllowance } from './support.js'

/**
 * The browser share as the API sees it (`#736`): a port, so the two sockets and
 * the tools over them are testable without a PostgreSQL.
 *
 * The same arrangement `DropStore` in `operator-drops.ts` uses, and for the same
 * reason — every rule about *who may* lives in `packages/db/src/storage`, next to
 * the statement that enforces it, and this interface is only the shape a route
 * calls it through.
 */
export interface ShareDesk {
  /**
   * The agent offers its tab, with the sentence its operator will read.
   *
   * Three refusals and they are all decided in storage (`#737`): one share
   * already open, no linked operator, or the citizen does not hold
   * `browser-session`. What comes back is a reason and never a sentence — the
   * prose belongs to whichever surface is speaking, and there is more than one.
   */
  readonly offer: (command: OfferShareCommand) => Promise<OfferShareOutcome>
  /** The share this agent has going, if any. `offered` or `live`. */
  readonly live: (agentId: AgentId) => Promise<ShareSummary | null>
  /** The last one it had, for reading back how it ended. */
  readonly latest: (agentId: AgentId) => Promise<ShareSummary | null>
  /**
   * What a waking citizen is told about: an open share, or one that closed
   * inside the window it was away for.
   *
   * Separate from {@link live} because the two answer different questions.
   * *What is open right now* is what the status tool asks; *what should greet
   * me* has to include the offer that lapsed unanswered at three in the
   * morning, which is exactly the one `live` is right to omit.
   */
  readonly forWakeup: (agentId: AgentId, since: string) => Promise<ShareSummary | null>
  /** The agent's socket presents its token. Null for every closed state. */
  readonly forToken: (token: string) => Promise<ShareForRelay | null>
  /** The operator's window names the share, and its session says who it is. */
  readonly accept: (shareId: string, humanId: HumanId) => Promise<AcceptShareOutcome>
  /** End it. Idempotent — the first reason wins. */
  readonly close: (shareId: string, reason: ShareCloseReason) => Promise<boolean>
  /**
   * The share behind an id, if this person may open its window (`#738`).
   *
   * **`null` rather than a refusal**, so the console can hand a guessed id, a
   * stranger's share and a closed one the same thing a mistyped path gets.
   */
  readonly offeredTo: (shareId: string, humanId: HumanId) => Promise<WaitingShare | null>
}

export function databaseShares(db: Database): ShareDesk {
  return {
    offer: (command) => offerShare(db, command),
    live: (agentId) => liveShare(db, agentId),
    latest: (agentId) => latestShare(db, agentId),
    forWakeup: (agentId, since) => shareForWakeup(db, agentId, since),
    forToken: (token) => shareForToken(db, token),
    accept: (shareId, humanId) => acceptShare(db, shareId, humanId),
    close: (shareId, reason) => closeShare(db, shareId, reason),
    offeredTo: (shareId, humanId) => shareOfferedTo(db, shareId, humanId),
  }
}

/**
 * What a refused offer says to the citizen that asked (`#737`).
 *
 * **Storage decides *whether*, this decides *what it sounds like*.** The reason
 * is an enum precisely so that this table can exist: there is more than one
 * surface — the MCP tool today, whatever asks next — and a sentence baked into a
 * SQL function would be a sentence every one of them had to live with.
 *
 * Each of the three names the next move, because a refusal an agent cannot act
 * on costs it the same turn as one it can:
 *
 * - `already-open` is `conflict`. Nothing is wrong with the request and nothing
 *   is forbidden; the Colony has to change state first, which is what 409 means
 *   in `errors.ts` and what no other code in the vocabulary means.
 * - `no-operator` is `conflict` for the same reason. It is not the citizen's
 *   fault and not permanent — a link is one call away — so `forbidden` would
 *   read as *you are not the sort of citizen that may do this*, which is false.
 * - `no-skill` is `forbidden`, following the argument `skills.ts` already makes
 *   for that code: the vocabulary is closed on purpose, and *you may not do this
 *   because of what you hold* is what it already means.
 */
const OFFER_REFUSALS: Record<OfferRefusal, ApiError> = {
  'already-open': {
    code: 'conflict',
    message:
      'You already have a share open, and one at a time is the rule. Read it with ' +
      'kolonie.browser.share.status: if your operator is on it, let them finish; if it is an ' +
      'offer you have moved on from, kolonie.browser.share.close frees the slot and costs you ' +
      'nothing. A second offer would point at a tab you are no longer on, arriving at somebody ' +
      'with no way to tell.',
  },
  'no-operator': {
    code: 'conflict',
    message:
      'There is nobody to hand this to. A share goes to the one person linked to you and to ' +
      'nobody else — no pool, no volunteer, no other citizen — so without a link there is no ' +
      'recipient for the Colony to offer it to. kolonie.operator.link is the whole of it, and ' +
      'this is not a judgement about you: many citizens run with no operator permanently, and ' +
      'they simply do not have this channel.',
  },
  'no-skill': {
    code: 'forbidden',
    message:
      `Handing over a live tab needs the ${BROWSER_SHARE_SKILL} rung, and you do not hold it ` +
      'yet. What a share is worth is a tab with state in it — a session, a half-filled form — ' +
      'and that rung is where the Colony has seen you keep one across a restart. Without it ' +
      'your operator would arrive at a page you could have reloaded yourself. ' +
      'kolonie.tasks.frontier names the task that grants it.',
  },
}

/**
 * Where the Colony's own word to the operator got to (`#774`).
 *
 * **Reported and never a refusal**, which is the half of the proposal that was
 * turned down: the ticket asked for `share.open` to fail when the operator cannot
 * be notified, and that would trade a channel that works for one that reports
 * well. The offer sits in the person's console queue for
 * {@link BROWSER_SHARE_OFFER_HOURS} hours whether a mail went or not, and an agent
 * whose operator happens to check their queue would have been refused a working
 * handover to spare it a wait it was not doing anyway — the tool does not block.
 *
 * What the citizen gets instead is the truth, in a word it can branch on, because
 * *nobody was told* and *somebody was told* are the difference between offering
 * and finding another way:
 *
 * - `delivered` — a mail went to the person linked to you.
 * - `no-address` — they are linked, and the Colony holds no address for them.
 *   The one an agent can act on: a GitHub account that keeps its address private
 *   leaves nothing to write to, and their console profile is where that is fixed.
 * - `capped` — your own outbound-mail allowance is spent. Not a share limit; the
 *   same ceiling a support ticket and an operator request charge, shared for the
 *   reason {@link OutboundAllowance} gives, and it is what stops *offer, withdraw,
 *   offer again* from being an unmetered way to fill one person's inbox.
 * - `undeliverable` — the Colony tried and could not, or this deployment sends no
 *   mail at all. Nothing for the citizen to do and nothing about its standing.
 */
export type ShareNotifyStatus = 'delivered' | 'no-address' | 'capped' | 'undeliverable'

/**
 * The Colony telling a person their agent is waiting on them.
 *
 * A port for the reason {@link ShareDesk} is one, and a second one rather than a
 * method on it: the desk is storage and is deliberately testable with no
 * PostgreSQL, while this holds a mailer, a ceiling and a configured host. Keeping
 * them apart is also what lets a deployment have a desk and no mail — see
 * `undeliverable` above, which is that case reported rather than hidden.
 */
export interface ShareNotifier {
  notify(offer: {
    readonly agentId: AgentId
    readonly agentName: string
    readonly shareId: string
    readonly expiresAt: string
  }): Promise<ShareNotifyStatus>
}

/**
 * What the citizen is handed when the offer stands.
 *
 * A type alias rather than an `interface`, because this is returned as an MCP
 * tool's `structuredContent` and only an alias carries the implicit index
 * signature that assignment wants. The neighbouring channels get theirs for free
 * by inferring the shape from a core Zod schema; this one has no schema to
 * infer from, since none of these fields ever crosses the HTTP door.
 */
export type OpenedShare = {
  readonly id: string
  /**
   * The secret its own sharer presents to attach the stream. **Handed back once
   * and never again**, because the Colony keeps only its hash.
   *
   * It is the agent's and not the operator's: the person reaches the session
   * from their own queue, which is why nothing here is a link. An agent able to
   * mint an operator-facing URL would be an agent able to send one anywhere.
   */
  readonly token: string
  readonly expiresAt: string
  /**
   * Whether anybody was actually told (`#774`).
   *
   * **The answer to a question that had none.** An offer used to come back as an
   * id and a deadline, from which a citizen could not tell whether a person had
   * been reached or whether it had just written into a queue nobody opens — so
   * unattended runs guessed, and the ticket that asked for this reports agents
   * inventing channels of their own to be sure.
   */
  readonly notifyStatus: ShareNotifyStatus
}

export type OpenShareOutcome =
  | { readonly outcome: 'offered'; readonly response: OpenedShare }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Offer a tab, tell the person, and turn a refused offer into something a
 * citizen can act on.
 *
 * What this adds to {@link ShareDesk.offer} is the wording and the knock. Note
 * what it still does **not** add: no URL, no operator address, no name. The
 * answer is an id, a token for the agent's own sharer, a deadline, and a word
 * for where the Colony's own mail got to.
 *
 * **The offer is written before anything is sent, and nothing is unwritten if
 * the sending fails.** That order is the whole design: the queue entry is the
 * channel and the mail is a courtesy on top of it, so a share that is already
 * openable is never destroyed to keep a report tidy.
 */
export async function openShare(
  agentId: AgentId,
  agentName: string,
  command: { targetId: string; purpose: string; provider?: string | null; step?: number | null },
  shares: ShareDesk,
  notifier?: ShareNotifier | undefined,
): Promise<OpenShareOutcome> {
  const offered = await shares.offer({ agentId, ...command })

  if (offered.outcome === 'refused') {
    return { outcome: 'rejected', error: OFFER_REFUSALS[offered.reason] }
  }

  const notifyStatus =
    notifier === undefined
      ? 'undeliverable'
      : await notifier.notify({
          agentId,
          agentName,
          shareId: offered.share.id,
          expiresAt: offered.share.expiresAt,
        })

  return { outcome: 'offered', response: { ...offered.share, notifyStatus } }
}

/**
 * What the Colony writes to a person whose agent is waiting on them (`#774`).
 *
 * Two rules, both taken from `operatorRequestNotificationText`, which is the
 * same problem solved for the same recipient:
 *
 * **The agent's own sentence does not travel.** `purpose` is free text an agent
 * wrote, and a mail from the Colony carrying it into somebody's inbox is a
 * sentence of an agent's choosing arriving under the Colony's name — a phishing
 * surface, and a channel worth the trouble of finding out how to abuse. It is on
 * the queue entry, where the person is signed in and reading it as their agent's
 * words. So this mail says *who* and *how long*, and the *what* waits on the page.
 *
 * **The link is the share's own page, and the Colony builds it.** `#768` is the
 * argument: an operator who had to assemble that URL themselves pasted the token
 * where the id goes and got an error page, because the two are opaque strings
 * handed over together and nothing distinguished them. A link nobody has to
 * construct removes that whole class of failure. It carries no authority — the
 * page still wants their session and still checks `human_agents` — so what is in
 * the mail is a destination and not a key, and forwarding it grants nothing.
 */
export function shareOfferNotificationText(offer: {
  readonly agentName: string
  readonly shareId: string
  readonly expiresAt: string
  readonly consoleUrl: string
}): string {
  return (
    `${offer.agentName} is stuck on a page and has offered you the tab.\n\n` +
    'Opening it puts you on that one tab, live, with what it wrote about why. Nothing else of ' +
    `its browser is reachable, and the window lasts ${BROWSER_SHARE_LIVE_MINUTES} minutes once ` +
    'you arrive.\n\n' +
    `${offer.consoleUrl}/browser/share/${offer.shareId}\n\n` +
    'You will be asked to sign in if you are not — the link is a destination and not a key, and ' +
    'it opens for nobody but you.\n\n' +
    `The offer lapses at ${offer.expiresAt} on its own, and letting it costs your agent ` +
    'nothing: it is told that nobody came, and it may ask again.'
  )
}

/**
 * The Colony's own mail, and the only place a share becomes a link (`#774`).
 *
 * The link is built here, from a host this deployment was configured with, and
 * handed to a person the Colony can name — never returned to the citizen, which
 * is the distinction the no-URL rule in `mcp/tools/browser-share.ts` is actually
 * about. An agent may cause a link to exist; it may not hold one.
 *
 * **The recipient is the linked person and not `operator_addresses`.** Reaching
 * the share needs their console session, so the address has to belong to somebody
 * who can sign in. The address a citizen *named* on the autonomy form may be
 * anybody at all, and mailing them a page they cannot open would be worse than
 * sending nothing.
 */
export function mailingShareNotifier(deps: {
  readonly recipient: (agentId: AgentId) => Promise<{ readonly email: string | null } | undefined>
  readonly mailer: OperatorMailer | undefined
  readonly consoleUrl: string | undefined
  readonly allowance: OutboundAllowance
  readonly log: Log
}): ShareNotifier {
  return {
    notify: async (offer) => {
      if (deps.mailer === undefined || deps.consoleUrl === undefined) return 'undeliverable'

      const operator = await deps.recipient(offer.agentId)
      if (operator === undefined || operator.email === null) return 'no-address'

      const charged = deps.allowance.charge(offer.agentId)
      if (!charged.allowed) return 'capped'

      const delivery = await deps.mailer.send({
        to: operator.email,
        subject: `${offer.agentName} has asked you to take over a page`,
        text: shareOfferNotificationText({
          agentName: offer.agentName,
          shareId: offer.shareId,
          expiresAt: offer.expiresAt,
          consoleUrl: deps.consoleUrl,
        }),
      })

      if (!delivery.delivered) {
        deps.log.warn('a browser share offer could not be mailed to its operator', {
          event: 'browser.share.notify.failed',
          shareId: offer.shareId,
          reason: delivery.reason ?? 'unknown',
        })
        return 'undeliverable'
      }

      return 'delivered'
    },
  }
}

/**
 * One line of English for a share, for the citizen reading its own state back.
 *
 * Written here rather than in the tool because the wake-up says the same thing
 * (`#737`) and two places phrasing *your operator is on it* differently is two
 * places to be corrected.
 */
export function describeShare(share: ShareSummary): string {
  const asked = `You asked for: ${share.purpose}${whereItIs(share)}`

  if (share.state === 'offered') {
    return (
      `Your offer is waiting — nobody has arrived yet, and it lapses ${share.expiresAt} ` +
      `(${BROWSER_SHARE_OFFER_HOURS} hours from when you made it). ${asked}\n\n` +
      'Do not wait on this. End your turn and read it again when you next wake.'
    )
  }

  if (share.state === 'live') {
    return (
      `Your operator is on it now, until ${share.expiresAt}. ${asked}\n\n` +
      'Keep your sharer attached; the tab is theirs until the window closes.'
    )
  }

  const ending: Record<ShareCloseReason, string> = {
    completed:
      'Your operator finished and closed the window. Whether the page is actually past what ' +
      'stopped you is yours to check — the Colony did not look at it and cannot tell you.',
    expired:
      'Nobody arrived before it lapsed, or the live window ran out mid-form. It cost you the ' +
      'offer and nothing else: the tab, its cookies and anything half-filled are untouched, and ' +
      'you may offer again.',
    lost:
      'Your own sharer went away — a restart, a crash, a closed laptop. The token did not ' +
      'survive it, so offer again once you are attached.',
    cancelled: 'You withdrew it yourself.',
  }

  return (
    `${share.closedFor === null ? 'It is over.' : ending[share.closedFor]}\n\n` +
    `${asked} Closed ${share.closedAt ?? 'just now'}.`
  )
}

/** " (mail.tm, step 3)", " (mail.tm)", " (step 3)" or nothing at all. */
function whereItIs(share: ShareSummary): string {
  const parts = [
    ...(share.provider === null ? [] : [share.provider]),
    ...(share.step === null ? [] : [`step ${share.step}`]),
  ]
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}
