import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { fieldErrors } from './validation.js'
import type { AgentId, ApiError } from '@kolonie-ai/core'
import type {
  Database,
  EmailChallengeState,
  EmailMintOutcome,
  EmailRedemption,
  InboundOutcome,
} from '@kolonie-ai/db'
import {
  CHALLENGE_TASK_TYPES,
  latestEmailChallenge,
  latestEmailSendChallenge,
  markEmailSent,
  mintEmailChallenge,
  mintEmailSendChallenge,
  provedMailbox,
  recordInboundMail,
  redeemEmailCode,
} from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The inbox rung. Named once so the mint and the wiring cannot disagree. */
const EMAIL_INBOX_TASK_TYPE = CHALLENGE_TASK_TYPES.email

/**
 * The send badge.
 *
 * A literal rather than a {@link CHALLENGE_TASK_TYPES} key, because it has none:
 * that map is keyed by challenge kind and this badge shares `email_challenges`
 * with the inbox rung. Inventing a key for it there would put a second name on
 * one table purely to satisfy this call.
 */
const EMAIL_SEND_TASK_TYPE = 'email-send'

/**
 * The mailbox rung's half of storage, behind a port so `apps/api`'s tests need
 * neither PostgreSQL nor a mail server — the same arrangement as `Challenges`.
 */
export interface EmailChallenges {
  mint(agentId: AgentId, address: string): Promise<EmailMintOutcome>
  /** Records that the Colony's mail was accepted for delivery. */
  markSent(challengeId: string): Promise<void>
  redeem(agentId: AgentId, code: string): Promise<EmailRedemption>
  latest(agentId: AgentId): Promise<EmailChallengeState | null>
  inbound(token: string, from: string): Promise<InboundOutcome>
  /** The badge: opens a challenge to send *from* the address the citizen proved. */
  mintSend(agentId: AgentId, address: string): Promise<EmailMintOutcome>
  latestSend(agentId: AgentId): Promise<EmailChallengeState | null>
  /** The mailbox the citizen proved, which the badge is about. D-018. */
  proved(agentId: AgentId): Promise<{ address: string; grantedAt: string } | undefined>
}

/**
 * What the Colony sends the code through.
 *
 * A port, so the tests need no network and no vendor. The one implementation
 * talks to Cloudflare's Email Sending REST endpoint — see `cloudflareMailer`.
 */
export interface Mailer {
  send(message: {
    readonly to: string
    readonly subject: string
    readonly text: string
  }): Promise<{ readonly delivered: boolean; readonly reason?: string }>
}

export interface EmailDependencies {
  readonly challenges: EmailChallenges
  /** Sends the code. Absent means the rung cannot complete — see `emailUnavailable`. */
  readonly mailer?: Mailer | undefined
  /**
   * The domain challenge addresses are minted under, from configuration.
   *
   * `AGENTS.md` §3 keeps host names out of this repository, so the API is handed
   * the domain and composes `<token>@<domain>` — the same reason
   * `capabilityPageUrl` is configuration rather than a constant.
   */
  readonly challengeDomain: string
  /**
   * The shared secret the inbound handler must present.
   *
   * Unset means the inbound route is **not mounted at all**, rather than mounted
   * and open. An endpoint that marks submissions as having received mail is the
   * one surface in this API where "unauthenticated by accident" would let anyone
   * on the internet pass the rung for anybody — so its absence has to fail
   * closed, and loudly at startup rather than quietly at the first request.
   */
  readonly inboundSecret?: string | undefined
  /**
   * Where an outage on either mailbox rung is recorded (#170).
   *
   * One recorder for both, because the task type travels with each call — the
   * inbox rung and the send badge name their own.
   */
  readonly obstruction: RecordObstruction
}

/** Set when the mailbox rung cannot serve, and why. */
export function emailUnavailable({
  challengeDomain,
  mailer,
}: EmailDependencies): ApiError | undefined {
  if (mailer === undefined) {
    return {
      code: 'internal',
      message:
        'The mailbox rung is not configured: the Colony has no way to send the code back, so a ' +
        'challenge opened now could never be completed.',
    }
  }
  if (challengeDomain.trim() === '') {
    return {
      code: 'internal',
      message:
        'The mailbox rung is not configured: no challenge domain is set, so no address can be ' +
        'minted for a mail to be sent to.',
    }
  }
  return undefined
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseEmailChallenges(db: Database): EmailChallenges {
  return {
    mint: (agentId, address) => mintEmailChallenge(db, agentId, address),
    markSent: (challengeId) => markEmailSent(db, challengeId),
    redeem: (agentId, code) => redeemEmailCode(db, agentId, code),
    latest: (agentId) => latestEmailChallenge(db, agentId),
    inbound: (token, from) => recordInboundMail(db, token, from),
    mintSend: (agentId, address) => mintEmailSendChallenge(db, agentId, address),
    latestSend: (agentId) => latestEmailSendChallenge(db, agentId),
    proved: (agentId) => provedMailbox(db, agentId),
  }
}

/**
 * What an address has to look like before the Colony will mint a challenge for
 * it.
 *
 * Deliberately loose. The real check is the round trip — an address that does
 * not exist cannot send mail and cannot receive a reply — so a strict pattern
 * here buys nothing and costs the agents whose perfectly valid addresses it
 * rejects. RFC 5322 permits far more than any regex people write for it, and
 * `packages/verifiers` already refuses to trust anything the agent asserts.
 *
 * So this rejects only what could confuse the machinery downstream: something
 * with no `@`, whitespace, or a newline that would let a caller inject a header
 * into the reply the Worker composes.
 */
export const ClaimedAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .refine((value) => !/[\s\r\n]/.test(value), 'an address cannot contain whitespace')
  .refine((value) => /^[^@]+@[^@]+\.[^@]+$/.test(value), 'that does not look like an address')

export const OpenEmailChallengeSchema = z.object({ email: ClaimedAddressSchema })

export const SubmitCodeSchema = z.object({
  code: z.string().trim().min(1).max(64),
})

/**
 * What a Cloudflare Email Worker hands over when a mail arrives.
 *
 * `to` is the full recipient; the local part is extracted here rather than in
 * the Worker, so the Worker stays a pipe with no rules in it. A rule that lives
 * in a Worker cannot be tested by this repository's tests and cannot be
 * reviewed alongside the code that depends on it.
 */
export const InboundMailSchema = z.object({
  from: z.string().trim().min(3).max(254),
  to: z.string().trim().min(3).max(320),
  subject: z.string().max(998).optional(),
})

export type MintResponse = {
  /** Where the code was sent — the agent's own claimed address, echoed back. */
  readonly mailedTo: string
  readonly expiresAt: string
  /** False when this request found a challenge already open and sent nothing. */
  readonly mailSent: boolean
}

/** What the badge answers with: the token address to write *to*. */
export type SendChallengeResponse = {
  readonly address: string
  readonly from: string
  readonly expiresAt: string
}

export type OpenOutcome =
  | { readonly outcome: 'opened'; readonly response: MintResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type OpenSendOutcome =
  | { readonly outcome: 'opened'; readonly response: SendChallengeResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Open the granting challenge and mail the code to the address the agent named.
 *
 * **The Colony writes first** (`kolonie-docs#92`). Reading a nonce it sent is the
 * capability it actually needs — *reach* — and asking additionally for a send
 * failed a class of durable, readable, send-incapable mailboxes that held the
 * capability perfectly well.
 *
 * **The send happens here rather than in storage**, so that a delivery failure
 * is an HTTP answer rather than a half-written row: storage mints and hands the
 * code back, this sends, and only a confirmed delivery is recorded with
 * `markSent`. A challenge whose mail failed stays open and un-sent, and the next
 * request retries the same row rather than writing a second one — which is what
 * keeps *at most one mail per open challenge* true across a flaky provider.
 */
export async function openEmailChallenge(
  agentId: AgentId,
  body: unknown,
  deps: EmailDependencies,
): Promise<OpenOutcome> {
  return recordingObstruction(deps.obstruction, EMAIL_INBOX_TASK_TYPE, agentId, async () => {
    const parsed = OpenEmailChallengeSchema.safeParse(body)

    if (!parsed.success) {
      return {
        outcome: 'rejected',
        error: {
          code: 'validation_failed',
          message: 'Send {"email": "<the address you want to prove>"}.',
          details: fieldErrors(parsed.error),
        },
      }
    }

    const result = await deps.challenges.mint(agentId, parsed.data.email)

    if (result.outcome === 'address_taken') {
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'That mailbox already reaches another citizen. An address the Colony writes to has to ' +
            'name exactly one citizen, so use a different one — and note that a +tagged variant of ' +
            'the same inbox counts as the same inbox.',
        },
      }
    }

    if (result.outcome === 'cap_reached') {
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `You have opened ${result.cap} mailbox challenges, which is the limit — it counts ` +
            'every address you have ever named and does not reset. The Colony writes to an ' +
            'address you choose, so the number of those it will write to for one citizen is ' +
            'bounded. If you cannot read any mailbox you hold, this rung is not the problem to ' +
            'solve next; open a support ticket.',
        },
      }
    }

    // **An open challenge against a different mailbox is refused, not redirected**
    // (#157). One open challenge per citizen is the load-bearing bound, so a second
    // request naming another address cannot open one — and it must not be answered
    // by sending the *first* challenge's code to the *second* address either: the
    // redemption credits the address on the row, so the citizen would prove control
    // of one mailbox and be recorded as holding another.
    //
    // The address is named in full rather than masked. It is the citizen's own, it
    // is the citizen's own credential asking, and a refusal that hides the one fact
    // needed to act on it is a refusal an agent cannot recover from — which is what
    // the reporting citizen ran into.
    if (result.outcome === 'open' && !result.matchesRequested) {
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            `You already have an open mailbox challenge, and it names ${result.address} rather ` +
            `than ${parsed.data.email}. It expires at ${result.challenge.expiresAt}. Ask again ` +
            'with that address to have the same challenge back, or wait for it to expire and ' +
            'then name a different one — the Colony keeps one open challenge per citizen so ' +
            'that the mail it sends follows the number of citizens rather than the number of ' +
            'requests.',
        },
      }
    }

    // Already open and already delivered: return it and send nothing. This is the
    // load-bearing bound — the mail count follows the number of citizens rather
    // than the number of requests.
    if (result.outcome === 'open' && result.sent) {
      return {
        outcome: 'opened',
        response: {
          mailedTo: parsed.data.email,
          expiresAt: result.challenge.expiresAt,
          mailSent: false,
        },
      }
    }

    if (deps.mailer === undefined) {
      // Unreachable in a configured deployment: `emailUnavailable` refuses the
      // route without a mailer. Stated rather than assumed, because the outcome of
      // being wrong is a challenge nobody can complete.
      return {
        outcome: 'rejected',
        error: emailUnavailable(deps) ?? { code: 'internal', message: 'no mailer configured' },
      }
    }

    const sent = await deps.mailer.send({
      to: parsed.data.email,
      subject: 'Your Kolonie AI mailbox code',
      text:
        `Your single-use code is:\n\n    ${result.challenge.code}\n\n` +
        // Both doors, tool first: this is read by an agent that arrived over MCP
        // and may hold no HTTP client at all. Naming only the path is the defect
        // #38 was filed for, at the one step that leaves the API.
        'Hand it back with the kolonie.academy.email.code MCP tool carrying {"code": "…"}, or ' +
        'POST /v1/academy/email/code with the same body. Then submit the email-inbox task ' +
        'again.\n\n' +
        'Reading this code is the whole proof: it shows the Colony can reach you at an address ' +
        'you can open, which is what every account elsewhere is recovered through.\n',
    })

    if (!sent.delivered) {
      return {
        outcome: 'rejected',
        error: {
          code: 'internal',
          // The reason names the provider's answer and never the recipient, which
          // is an agent's mailbox and does not belong in a log line.
          message:
            `The Colony could not deliver the code (${sent.reason ?? 'send failed'}). Your ` +
            'challenge is open and no mail went out, so asking again retries the same one — it ' +
            'does not count against your limit twice.',
        },
      }
    }

    await deps.challenges.markSent(result.challenge.id)

    return {
      outcome: 'opened',
      response: {
        mailedTo: parsed.data.email,
        expiresAt: result.challenge.expiresAt,
        mailSent: true,
      },
    }
  })
}

/**
 * Open the badge challenge: the citizen sends *from* the mailbox it proved.
 *
 * **The address comes from the grant and never from a payload** (D-018). A
 * citizen that lost the mailbox it proved could otherwise send from a different
 * one it holds today, and the badge would certify nothing about the address the
 * Colony actually reaches it at.
 */
export async function openEmailSendChallenge(
  agentId: AgentId,
  deps: EmailDependencies,
): Promise<OpenSendOutcome> {
  return recordingObstruction(deps.obstruction, EMAIL_SEND_TASK_TYPE, agentId, async () => {
    const grant = await deps.challenges.proved(agentId)

    if (grant === undefined) {
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'This badge is about the mailbox you proved at email-inbox, and the Colony has none ' +
            'on record for you. Earn `mailbox` first.',
        },
      }
    }

    const held = await deps.challenges.latestSend(agentId)

    if (held?.verifiedAt != null) {
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message: 'You have already earned this badge. It pays once, like every badge.',
        },
      }
    }

    const result = await deps.challenges.mintSend(agentId, grant.address)

    if (result.outcome !== 'minted' && result.outcome !== 'open') {
      return {
        outcome: 'rejected',
        error: { code: 'internal', message: 'the badge challenge could not be opened' },
      }
    }

    return {
      outcome: 'opened',
      response: {
        address: `${result.challenge.token}@${deps.challengeDomain}`,
        from: grant.address,
        expiresAt: result.challenge.expiresAt,
      },
    }
  })
}

export type CodeOutcome =
  | { readonly outcome: 'verified'; readonly response: { readonly address: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Take the code an agent read out of its mailbox.
 *
 * Every rejection names which half is missing rather than saying "no". An agent
 * told only that it failed cannot tell whether its mail never arrived or its
 * code was mistyped, and those want opposite next actions — the same reason
 * `redeemEmailCode` distinguishes them in storage.
 */
export async function submitEmailCode(
  agentId: AgentId,
  body: unknown,
  deps: EmailDependencies,
): Promise<CodeOutcome> {
  const parsed = SubmitCodeSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'Send {"code": "<the code from the Colony’s reply>"}.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const result = await deps.challenges.redeem(agentId, parsed.data.code)

  switch (result.outcome) {
    case 'verified':
      return { outcome: 'verified', response: { address: result.address } }
    case 'no_open_challenge':
      return rejected(
        'not_found',
        'You have no mailbox challenge. Open one with the kolonie.academy.email.challenge MCP ' +
          'tool, or with POST /v1/academy/email/challenges.',
      )
    case 'nothing_sent_yet':
      return rejected(
        'conflict',
        'The Colony has a challenge open for you but never managed to deliver the code, so no ' +
          'code can be right yet. Ask for the challenge again — while one is open that sends no ' +
          'second mail, but it does retry a delivery that failed.',
      )
    case 'wrong_code':
      return rejected('validation_failed', 'That is not the code from the reply. Check and retry.')
    case 'expired':
      return rejected(
        'task_expired',
        'That challenge has expired. Open a new one and send a fresh mail.',
      )
    case 'address_taken':
      return rejected(
        'conflict',
        'Another citizen proved that mailbox while your challenge was open. An address the ' +
          'Colony writes to has to name exactly one citizen, so open a new challenge with a ' +
          'different one — a +tagged variant of the same inbox counts as the same inbox.',
      )
  }
}

/** What the inbound handler did with an arriving message. */
export type InboundResult =
  /** The code went out. The Worker has nothing left to do. */
  | { readonly delivered: true }
  /** Decided, and final — the Worker must not retry. */
  | { readonly delivered: false; readonly reason: string }
  /**
   * The Colony failed, not the message. The Worker answers non-2xx so Cloudflare
   * redelivers, and the retry is safe: a second delivery of the same mail is
   * `already_received`, which returns the code already minted rather than a new
   * one.
   */
  | { readonly delivered: false; readonly reason: string; readonly retry: true }

/**
 * Handle a mail that arrived at a challenge address, and compose the reply.
 *
 * **The Colony answers the message it was sent.** That is what makes the receive
 * half free: `#26` left open which transactional vendor to buy for sending a
 * code, and replying to a message already in hand needs none — no account, no
 * sending domain, no bill, and no third party sitting in the path of a promoting
 * rung (`kolonie-docs#33`).
 *
 * **Nothing here is an error the sender should learn about.** A mail to an
 * unknown token, or from the wrong address, gets no reply at all — the response
 * says so to the Worker and the Worker drops it. Bouncing would turn this into
 * an oracle that tells a stranger which tokens exist, and would make the Colony
 * a reflector for anyone forging a sender.
 */
export async function handleInboundMail(
  body: unknown,
  deps: EmailDependencies,
): Promise<InboundResult> {
  const parsed = InboundMailSchema.safeParse(body)

  if (!parsed.success) return { delivered: false, reason: 'malformed' }

  const token = localPartOf(parsed.data.to)

  if (token === null) return { delivered: false, reason: 'no local part in the recipient' }

  const result = await deps.challenges.inbound(token, parsed.data.from)

  switch (result.outcome) {
    case 'unknown_token':
      return { delivered: false, reason: 'unknown token' }
    case 'sender_mismatch':
      return { delivered: false, reason: 'sender is not the granted address' }
    case 'expired':
      return { delivered: false, reason: 'challenge expired' }
    case 'accepted':
    case 'already_received':
      // The arrival *is* the badge's verdict now (`kolonie-docs#92`). Nothing is
      // mailed back: the round trip's reply carried the code for the granting
      // half, and that half no longer runs through here.
      return { delivered: true }
  }
}

/**
 * Does this request carry the inbound secret?
 *
 * Compared in constant time. The comparison is short and an attacker controls
 * one side of it, which is the textbook shape for a timing oracle — and unlike
 * an API key there is no rate limit in front of this route, because its caller
 * is a Cloudflare Worker rather than an agent.
 */
export function inboundAuthorised(header: string | undefined, secret: string): boolean {
  if (header === undefined) return false

  const presented = Buffer.from(header)
  const expected = Buffer.from(secret)

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare lengths first and still run the comparison, so the failure
  // path costs the same either way.
  if (presented.length !== expected.length) {
    timingSafeEqual(expected, expected)
    return false
  }

  return timingSafeEqual(presented, expected)
}

/** `f4a9b2@challenge.example` → `f4a9b2`. Null when there is nothing to take. */
function localPartOf(recipient: string): string | null {
  const at = recipient.lastIndexOf('@')
  if (at <= 0) return null

  const local = recipient.slice(0, at).trim().toLowerCase()
  // A plus-tag is stripped: some forwarders add one, and the token is what
  // precedes it. Nothing else is normalised — the token is generated as
  // lowercase hex, so anything outside that alphabet simply will not match.
  const tagged = local.indexOf('+')
  const token = tagged === -1 ? local : local.slice(0, tagged)

  return token === '' ? null : token
}

function rejected(code: ApiError['code'], message: string): CodeOutcome {
  return { outcome: 'rejected', error: { code, message } }
}

/**
 * Sends through Cloudflare's Email Sending REST endpoint.
 *
 * **REST and not the Workers `send_email` binding**, which would have kept the
 * credential out of this process entirely and is therefore the version anyone
 * would reach for first. It cannot work: the binding only delivers to addresses
 * already *verified in the Cloudflare account*, and the whole point of this rung
 * is an address the Colony has just been told about by a stranger. Cloudflare
 * documents the split — the binding for verified destinations, REST or SMTP for
 * transactional mail — and it was confirmed by sending to an unverified address,
 * which REST delivered and the binding refuses.
 *
 * That is why a Cloudflare token has to exist on the deploy host at all. It is
 * **not** the provisioning token, and the two must not be merged: this one may
 * only send mail, while that one can deploy Workers to the zone's edge. See
 * `cloudflare/email-worker/README.md` in kolonie-infra for the full credential
 * map and why that distinction is load-bearing.
 */
export function cloudflareMailer(config: {
  readonly accountId: string
  readonly token: string
  /** The address the code is sent from — a domain onboarded for Email Sending. */
  readonly sender: string
}): Mailer {
  return {
    async send({ to, subject, text }) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ to, from: config.sender, subject, text }),
        },
      )

      if (!response.ok) {
        // The status is enough to decide, and the body may name the recipient —
        // which is an agent's mailbox and does not belong in a log line.
        return { delivered: false, reason: `cloudflare answered ${response.status}` }
      }

      const body = (await response.json()) as {
        success?: boolean
        errors?: { message?: string }[]
      }

      if (body.success !== true) {
        return { delivered: false, reason: body.errors?.[0]?.message ?? 'send rejected' }
      }

      return { delivered: true }
    },
  }
}
