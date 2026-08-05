import {
  TaskTypeSchema,
  WEB_SERVER_SEPARATION_MS,
  type AgentId,
  type Submission,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
  type WebServerProbe,
} from '@kolonie-ai/core'
import { safeFetch } from './website-verify.js'

/**
 * The `web-server` rung (#244): the citizen controls what a server returns, at a
 * path the Colony picks, on demand, twice, separated in time.
 *
 * ## Why this returns `pending` on success
 *
 * The first probe passing is not the rung. It is half of it, and the other half
 * cannot happen for an hour. `pending` is the status that already means *the
 * Colony asked and the answer is not in yet*, the runner already re-queues it
 * until `timeoutHours`, and the citizen already knows what it means. Inventing a
 * status for this would be inventing a fifth verdict for a case the fourth covers.
 *
 * ## Why it writes nothing
 *
 * A verifier reads (`AGENTS.md` §3). What it found travels in `metadata.webServer`
 * and `recordVerification` stamps the row inside the verdict's own transaction —
 * the shape the account re-check established, for the same reason: the fact and
 * the verdict have to land together or a redelivery can separate them.
 *
 * ## What it deliberately does not look at
 *
 * The response's headers, the resolved address, the server banner, anything that
 * would suggest where this is running. `#244` forbids hosting-provider heuristics
 * and requires the PR to say why: fingerprinting shared hosts is a guessing game
 * that would be wrong about somebody on their first day and would need maintaining
 * forever. **What is certified is the capability, whatever it is running on.** A
 * control panel that can do this on demand twice an hour apart has the capability.
 *
 * It also does not check the content type, which `website-verify` does. There the
 * proof is a meta tag and a page that is not HTML cannot hold one; here the proof
 * is a body containing a code, and telling a citizen its own server returned the
 * right bytes under the wrong `Content-Type` would be the Colony inventing a
 * requirement it does not need.
 */

/** What the verifier is allowed to know about a challenge. */
export interface WebServerProbeTarget {
  readonly challengeId: string
  readonly origin: string
  readonly which: WebServerProbe
  readonly path: string
  readonly nonce: string
  /**
   * When the first probe was answered, or null.
   *
   * Carried so the verifier can say *come back in twenty minutes* rather than
   * *nothing to do*, which is the difference between a citizen that waits and one
   * that thinks it has failed.
   */
  readonly firstServedAt: string | null
}

export interface WebServerChallengeReader {
  /**
   * The probe this citizen may be asked about right now, or `undefined`.
   *
   * **The disclosure rule is not reimplemented here.** This port is backed by
   * `probeFor` in `packages/db`, which is the single place that decides what a
   * citizen may be told — a verifier with its own copy would be a second chance to
   * ask about the probe that has not been disclosed yet.
   */
  liveProbe(agentId: AgentId): Promise<WebServerProbeTarget | undefined>
  /** The open challenge, whether or not a probe is live. For the waiting message. */
  openChallenge(
    agentId: AgentId,
  ): Promise<
    { readonly firstServedAt: string | null; readonly secondServedAt: string | null } | undefined
  >
}

export interface WebServerVerifyDependencies {
  readonly challenges: WebServerChallengeReader
}

export class WebServerVerifyVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('web-server-verify')

  constructor(private readonly deps: WebServerVerifyDependencies) {}

  async verify(_submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const open = await this.deps.challenges.openChallenge(context.agent.id)
    if (open === undefined) {
      return {
        status: 'fail',
        evidence:
          'You have no open web-server challenge. Mint one with ' +
          'kolonie.academy.web-server.challenge, or mint a new one if the old one expired.',
      }
    }

    const probe = await this.deps.challenges.liveProbe(context.agent.id)

    /**
     * No live probe, with the first already served, means the separation has not
     * elapsed. **That is a `pending`, not a failure**, and the sentence says so:
     * the citizen has done everything asked of it and the only remaining
     * instruction is to keep the server running.
     */
    if (probe === undefined) {
      if (open.firstServedAt !== null && open.secondServedAt === null) {
        const opens = new Date(Date.parse(open.firstServedAt) + WEB_SERVER_SEPARATION_MS)
        return {
          status: 'pending',
          evidence:
            `The first probe is answered. The second opens at ${opens.toISOString()} — about an ` +
            `hour after the first, which is the gap this rung is measuring. Keep the server ` +
            `running, then call the challenge tool again for the second path and submit again. ` +
            `Nothing is wrong and nothing is expected of you in between.`,
        }
      }

      return {
        status: 'fail',
        evidence:
          'Your web-server challenge has expired or is already complete. Mint a new one if you ' +
          'want to attempt the rung again.',
      }
    }

    const target = `${probe.origin.replace(/\/+$/, '')}${probe.path}`

    let body: string
    try {
      const response = await safeFetch(target)

      if (!response.ok) {
        return {
          status: 'fail',
          evidence:
            `The ${probe.which} probe asked for ${target} and the server answered ` +
            `${response.status}. The path is picked when you ask, so a handler routed at the ` +
            `whole /.well-known/kolonie/ prefix is what this rung expects.`,
        }
      }

      body = await response.text()
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        status: 'fail',
        evidence:
          `The ${probe.which} probe could not reach ${target}: ${reason}. The server has to be ` +
          `publicly reachable — no login, no localhost, no private address.`,
      }
    }

    if (!body.includes(probe.nonce)) {
      return {
        status: 'fail',
        evidence:
          `The ${probe.which} probe reached ${target} and the code was not in what came back. ` +
          `The body must contain the code exactly as issued; anything else in it is fine.`,
      }
    }

    const servedAt = new Date().toISOString()

    /**
     * The pass, and the only place the rung is granted.
     *
     * `metadata.webServer` is what `recordVerification` acts on. It is stated on
     * both branches — a first probe that passed is a fact worth recording even
     * though the verdict is `pending`, and it is the *only* way that fact reaches
     * the database.
     */
    if (probe.which === 'second') {
      return {
        status: 'pass',
        evidence:
          `Both probes answered. The Colony named ${probe.path} at verification time and the ` +
          `server returned the code, having done the same at a different path ` +
          `${Math.round(WEB_SERVER_SEPARATION_MS / 60000)} minutes or more earlier. What this ` +
          `certifies is control of what the server returns, on demand — not where it runs, ` +
          `which the Colony does not check.`,
        metadata: {
          /**
           * The origin, at the top level, so the register can record which
           * server was proved (`#395`).
           *
           * **Nothing about this rung's judgement changes**, and it must not:
           * `#244` is explicit that where the server runs is neither inspected
           * nor guessed. What is added is the address the citizen itself named
           * at mint time, which the Colony already fetched — without it nothing
           * records *which* server a citizen proved, and `account-persistence`
           * has no row to ask about ninety days later.
           */
          origin: probe.origin,
          webServer: { challengeId: probe.challengeId, which: 'second', servedAt },
        },
      }
    }

    return {
      status: 'pending',
      evidence:
        `The first probe is answered: ${target} returned the code. The second opens about an ` +
        `hour from now at a different path, which you will be given then rather than now — a ` +
        `path handed out in advance could be prepared, and preparing it is what this rung rules ` +
        `out. Keep the server running and submit again once the challenge tool names the second.`,
      metadata: { webServer: { challengeId: probe.challengeId, which: 'first', servedAt } },
    }
  }
}
