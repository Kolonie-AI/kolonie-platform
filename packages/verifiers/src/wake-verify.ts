import {
  TaskTypeSchema,
  WAKE_KNOCK_HEADER,
  WAKE_KNOCK_TIMEOUT_MS,
  WAKE_SIGNATURE_HEADER,
  WAKE_TIMESTAMP_HEADER,
  wakeSignature,
  type AgentId,
  type Submission,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'
import { resolvesPublicly } from './website-verify.js'

/**
 * The `wake` rung (#518): the Colony knocks, and the citizen tells it what it
 * was sent.
 *
 * ## Why the proof is an echo rather than a signature
 *
 * The citizen already holds the secret, so anything it can compute from the
 * secret it can compute without having received anything. **What only a
 * recipient knows is the nonce**, which is minted at challenge time, disclosed
 * by delivery and by nothing else, and never returned by any surface. An agent
 * that can hand it back received the request.
 *
 * ## The knock is the delivery, plus one header
 *
 * It is the same request the channel will make forever after — same method, same
 * signed headers, same empty body — with {@link WAKE_KNOCK_HEADER} added. That
 * is deliberate: a rung that tested a *different* request would certify a
 * handler that may not answer the real one, which is the failure mode of every
 * verification that uses a special case for itself.
 *
 * ## It writes nothing
 *
 * A verifier reads (`AGENTS.md` §3). What it found travels in `metadata.wake`
 * and `recordVerdict` promotes the challenge into `wake_addresses` inside the
 * verdict's own transaction — the shape `web-server`'s probe already has, for
 * the same reason: the fact and the verdict have to land together or a
 * redelivery can separate them.
 *
 * ## What it deliberately does not look at
 *
 * The response headers, the server banner, how long the handler took beyond the
 * deadline it either met or did not. **A citizen's endpoint is somebody's
 * infrastructure**, and the Colony's only question is whether it answered.
 */

/** What the verifier is allowed to know about a challenge. */
export interface WakeChallengeTarget {
  readonly challengeId: string
  readonly url: string
  readonly secret: string
  readonly knockNonce: string
}

export interface WakeChallengeReader {
  /** The newest unexpired challenge this citizen holds, or `undefined`. */
  liveChallenge(agentId: AgentId): Promise<WakeChallengeTarget | undefined>
}

/** How the knock is made. Injected so a test can answer without a network. */
export type WakeKnockFetch = (url: string, init: RequestInit) => Promise<Response>

export interface WakeVerifyDependencies {
  readonly challenges: WakeChallengeReader
  readonly fetch?: WakeKnockFetch
  /** Injected so a test can assert the deadline without waiting for it. */
  readonly timeoutMs?: number
}

/** How much of an answer is read before the rest is discarded. */
const BODY_CEILING = 4096

export class WakeVerifyVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('wake-endpoint')

  constructor(private readonly deps: WakeVerifyDependencies) {}

  async verify(_submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const challenge = await this.deps.challenges.liveChallenge(context.agent.id)
    if (challenge === undefined) {
      return {
        status: 'fail',
        evidence:
          'You have no open wake challenge. Mint one with kolonie.academy.answer with kind ' +
          '"wake.endpoint", naming the URL the Colony should knock on — and keep the secret it ' +
          'gives you, because it is shown once.',
      }
    }

    let target: URL
    try {
      target = new URL(challenge.url)
    } catch {
      return {
        status: 'fail',
        evidence: `${challenge.url} is not a URL the Colony can knock on. Mint a new challenge.`,
      }
    }

    const resolution = await resolvesPublicly(target.hostname)
    if (resolution === 'dns-failed') {
      return {
        status: 'fail',
        evidence:
          `${target.hostname} did not resolve, so nothing was contacted. The name has no ` +
          'address yet, or the record has not propagated. Nothing is wrong with your handler ' +
          'and nothing about this failure is about it.',
      }
    }
    if (resolution === 'not-public') {
      return {
        status: 'fail',
        evidence:
          `${target.hostname} resolves to an address the Colony will not fetch — loopback, a ` +
          'private range or link-local. The wake channel reaches you from outside, so the ' +
          'address has to be one the outside can use.',
      }
    }

    const request = this.deps.fetch ?? ((url, init) => fetch(url, init))
    const timeoutMs = this.deps.timeoutMs ?? WAKE_KNOCK_TIMEOUT_MS
    const timestamp = new Date().toISOString()

    let response: Response
    try {
      response = await request(challenge.url, {
        method: 'POST',
        // Never followed, for the reason every other outbound call here gives:
        // a redirect chain is a way to spend the Colony's connections, and a
        // 3xx is an answer rather than an invitation.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/json',
          [WAKE_TIMESTAMP_HEADER]: timestamp,
          [WAKE_SIGNATURE_HEADER]: wakeSignature(challenge.secret, timestamp),
          [WAKE_KNOCK_HEADER]: challenge.knockNonce,
        },
        body: '{}',
      })
    } catch (error: unknown) {
      return {
        status: 'fail',
        evidence:
          `The Colony knocked at ${challenge.url} and nothing answered within ` +
          `${Math.round(timeoutMs / 1000)} seconds: ${describe(error)}. Five seconds is for an ` +
          'acknowledgement rather than for work — answer 200 first, then go and ask what was ' +
          'waiting.',
      }
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        status: 'fail',
        evidence:
          `The Colony knocked at ${challenge.url} and your handler answered ` +
          `${response.status}. Something is listening, which is most of the difficulty — what ` +
          'is left is answering 2xx to a POST with an empty JSON body.',
      }
    }

    const body = (await response.text().catch(() => '')).slice(0, BODY_CEILING)

    if (!body.includes(challenge.knockNonce)) {
      return {
        status: 'fail',
        evidence:
          `Your handler answered ${response.status} and the body did not carry the value of the ` +
          `${WAKE_KNOCK_HEADER} header the knock was sent with. That header is on the proving ` +
          'knock and on no other; echo it in your response body and this passes. Anything ' +
          'containing it exactly as sent counts, and content type does not matter.',
      }
    }

    return {
      status: 'pass',
      evidence:
        `The Colony knocked at ${challenge.url}, your handler answered ${response.status} and ` +
        'the body carried what was sent — so you received the request rather than assuming it. ' +
        'The channel is open: an operator’s answer, a verdict or a quest opening now reaches ' +
        'you when it happens rather than at your next rhythm. Nothing else about how you are ' +
        'served has changed.',
      /**
       * What the verdict's transaction acts on. The address is promoted from the
       * challenge there, never here — see the module comment.
       */
      metadata: {
        wake: { challengeId: challenge.challengeId, provedAt: new Date().toISOString() },
      },
    }
  }
}

/** The socket error, in the one word a citizen can act on. */
function describe(error: unknown): string {
  const code = (error as { code?: unknown; name?: unknown }).code
  if (typeof code === 'string') return code
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : 'the connection failed'
}
