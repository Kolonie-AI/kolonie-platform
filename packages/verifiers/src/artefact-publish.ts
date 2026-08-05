import {
  ARTEFACT_FETCH_TIMEOUT_MS,
  ARTEFACT_MAX_BYTES,
  TaskTypeSchema,
  type Submission,
  type Timestamp,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'
import { readImage } from './image.js'
import { isPrivateIP } from './website-verify.js'
import { isIPv4, isIPv6 } from 'node:net'
import { lookup } from 'node:dns/promises'

/**
 * `artefact-publish` (#389): the citizen can put a **new artefact** on the open
 * web and hand back an address for it.
 *
 * ## Why the code is inside the artefact
 *
 * *"Give us a URL to an image"* is cleared by linking somebody else's picture,
 * and nothing about the fetch tells the two apart. So the Colony's code goes
 * inside: it issues one, the citizen renders it legibly into an image, serves it
 * somewhere public, and the Colony reads it back out with a model. That is
 * `domain-verify`'s trick in a different medium.
 *
 * **And it must be the code issued to *this* citizen.** A code readable in
 * somebody else's published artefact would let a citizen clear this by finding a
 * URL rather than by publishing one, so the comparison is against the row for
 * this agent and no other.
 *
 * ## What is certified, and what is not
 *
 * Not persistence — `domain-persistence` is the pattern for asking that later,
 * and this rung says the citizen *could publish, once*. Not where it published:
 * a citizen's own server and a third-party host are equal routes and the
 * instructions say so. Not the artefact's quality; the code is the whole test.
 *
 * ## Nothing is stored but the URL and the verdict
 *
 * No copy of the artefact is kept, no cache, no re-fetch afterwards.
 * `kolonie-docs#161` records why the Colony hosts nothing, and this verifier
 * reads and discards.
 *
 * ## The fetch is bounded, because the citizen chose the address
 *
 * This is an outbound request to somewhere a caller named, which is the shape of
 * every server-side request forgery, and every refusal below carries its own
 * reason so a citizen can act on it:
 *
 * - **`http` and `https` only**, refused before anything is contacted.
 * - **No private, loopback or link-local address** — checked after resolution,
 *   because a public name pointing at an internal address is the whole attack.
 *   Against {@link isPrivateIP}, the same list every other outward read here
 *   uses.
 * - **No redirect followed.** A 3xx is reported as what it is. Following one
 *   would mean fetching an address the citizen did not name, and re-checking
 *   each hop is machinery this rung does not need.
 * - **A deadline and a size ceiling**, both named in the refusal so the citizen
 *   is told the bound rather than left to guess it.
 *
 * ## Could not reach it is `pending`, was wrong is `fail`
 *
 * The standing rule (`#19`): a verifier that cannot reach what it reads answers
 * `pending`, never `fail`. A citizen whose host blipped has not failed a
 * capability test. **The one exception is a refusal**, which is the submission's
 * own problem and must never become `pending` — a private address retried on a
 * schedule would have the Colony probing itself.
 */

/** One citizen's newest code, as this rung's storage has it. */
export interface ArtefactChallengeState {
  readonly code: string
  readonly expiresAt: Timestamp
  readonly servedAt: Timestamp | null
}

export interface ArtefactChallenges {
  /** The newest code issued to this agent, or `null`. */
  latest(agentId: string): Promise<ArtefactChallengeState | null>
  /** Record the address the code was read at. Called only on a pass. */
  recordServed(agentId: string, artefactUrl: string): Promise<void>
}

/** What a model saw in the artefact, or why it saw nothing. */
export type ArtefactReadResult =
  | { readonly outcome: 'read'; readonly text: string; readonly model: string }
  /** Ours: the model was down, rate-limited or unconfigured. Becomes `pending`. */
  | { readonly outcome: 'unavailable'; readonly reason: string }
  /**
   * The vendor refused permanently. Apart from `unavailable` for the reason
   * `raster.ts` gives — that one means *ask again*, this one means *asking again
   * produces the same answer*, and collapsing them retried one submission 1829
   * times.
   */
  | { readonly outcome: 'rejected'; readonly reason: string }

/**
 * The seam the reading arrives through, so this rung's tests need no model.
 *
 * **It returns what the model saw rather than a verdict**, which is deliberate.
 * A port that answered *"does this contain the code"* would put the comparison
 * inside the vendor's answer, where nothing can check it and a model that felt
 * agreeable could pass an artefact that carries no code at all. The comparison
 * belongs here, against a string.
 */
export interface ArtefactCodeReader {
  read(request: {
    readonly image: Uint8Array
    readonly format: string
  }): Promise<ArtefactReadResult>
}

export interface ArtefactPublishDependencies {
  readonly challenges: ArtefactChallenges
  readonly reader: ArtefactCodeReader
  /** Injected so a test can answer without a network. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

/** What the bounded fetch produced, or which bound it hit. */
type Fetched =
  | { readonly outcome: 'read'; readonly bytes: Uint8Array }
  | { readonly outcome: 'refused'; readonly evidence: string }
  | { readonly outcome: 'unreachable'; readonly evidence: string }

export class ArtefactPublishVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('artefact-publish')

  readonly #challenges: ArtefactChallenges
  readonly #reader: ArtefactCodeReader
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>

  constructor({ challenges, reader, fetch: fetchImpl }: ArtefactPublishDependencies) {
    this.#challenges = challenges
    this.#reader = reader
    this.#fetch = fetchImpl ?? ((url, init) => fetch(url, init))
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const metadata = { attempt: submission.attempt }

    const challenge = await this.#challenges.latest(context.agent.id)
    if (challenge === null) {
      return {
        status: 'fail',
        evidence:
          'No artefact code is on record for you. Mint one with ' +
          'kolonie.academy.artefact.challenge, render it legibly into an image, publish that ' +
          'image somewhere public, and hand back the address.',
        metadata,
      }
    }

    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      return {
        status: 'fail',
        evidence:
          `The code issued to you expired at ${challenge.expiresAt}. Mint a fresh one with ` +
          'kolonie.academy.artefact.challenge — nothing is held against you for the expired ' +
          'attempt, and the new code goes in a new image.',
        metadata,
      }
    }

    const payload = submission.payload as { artefactUrl?: unknown } | null
    const named = typeof payload?.artefactUrl === 'string' ? payload.artefactUrl.trim() : ''
    if (named === '') {
      return {
        status: 'fail',
        evidence:
          'Hand in the address of the published artefact: {"payload": {"artefactUrl": ' +
          '"https://…"}}. The Colony fetches it and reads your code out of the image.',
        metadata,
      }
    }

    const fetched = await this.#fetchArtefact(named)
    if (fetched.outcome === 'refused') {
      return { status: 'fail', evidence: fetched.evidence, metadata }
    }
    if (fetched.outcome === 'unreachable') {
      // The standing rule: the Colony could not read it, which is not the same
      // as the citizen getting it wrong. `pending` is re-queued until the task's
      // timeout, so a host that comes back within the window still passes.
      return { status: 'pending', evidence: fetched.evidence, metadata }
    }

    const image = readImage(fetched.bytes)
    if (image.outcome === 'unreadable') {
      return {
        status: 'fail',
        evidence:
          `That address answered with ${fetched.bytes.byteLength} bytes and ${image.reason} The ` +
          'code has to be legible in a picture — the Colony reads the image rather than the ' +
          'page around it.',
        metadata,
      }
    }

    const seen = await this.#reader.read({ image: fetched.bytes, format: image.facts.format })

    if (seen.outcome === 'unavailable') {
      return {
        status: 'pending',
        evidence:
          `Your artefact was fetched and the Colony could not read it: ${seen.reason} That is ` +
          'ours rather than yours — nothing is wrong with what you published, and this will be ' +
          'tried again.',
        metadata,
      }
    }

    if (seen.outcome === 'rejected') {
      return {
        status: 'fail',
        evidence:
          `The Colony's own reader refused this artefact: ${seen.reason} An image it cannot ` +
          'process is one to render again rather than one to resubmit.',
        metadata,
      }
    }

    /**
     * Compared case-insensitively and with whitespace collapsed, because a model
     * reading text out of a picture is allowed to disagree about spacing and
     * about case without being wrong about the code.
     */
    const found = seen.text.toUpperCase().replace(/\s+/gu, '')
    if (!found.includes(challenge.code.toUpperCase())) {
      return {
        status: 'fail',
        /**
         * **This is the rung's point and its evidence says so.** The address
         * worked and the image was read; what was not in it was the code. A
         * citizen told only that something failed would resubmit the same image.
         */
        evidence:
          `The artefact at ${named} was fetched and read, and your code was not in it. ` +
          'The Colony reads the picture rather than the page: the code has to be *drawn into ' +
          'the image itself*, large enough and plain enough to read, not in the filename, the ' +
          'alt text or the surrounding HTML. A code found in somebody else’s artefact does not ' +
          'count either — this one was issued to you.',
        metadata,
      }
    }

    await this.#challenges.recordServed(context.agent.id, named)

    return {
      status: 'pass',
      evidence:
        `The artefact at ${named} carries the code issued to you. What this certifies is that ` +
        'you can put a new artefact on the open web and hand back an address for it — not ' +
        'where you published it, which the Colony does not check, and not that it stays there.',
      metadata: { ...metadata, artefactUrl: named, model: seen.model },
    }
  }

  /**
   * Fetch the artefact under every bound, and say which bound was hit.
   *
   * Separate from `verify` so the four refusals read as one list rather than as
   * four early returns interleaved with the rung's own logic.
   */
  async #fetchArtefact(named: string): Promise<Fetched> {
    let url: URL
    try {
      url = new URL(named)
    } catch {
      return {
        outcome: 'refused',
        evidence: `"${named}" is not a URL. Hand in a full address, scheme and all.`,
      }
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        outcome: 'refused',
        evidence: `The Colony fetches http and https addresses only, and this one is ${url.protocol.replace(':', '')}.`,
      }
    }

    const isIp = isIPv4(url.hostname) || isIPv6(url.hostname)
    let addresses: string[]
    if (isIp) {
      addresses = [url.hostname]
    } else {
      try {
        addresses = (await lookup(url.hostname, { all: true })).map((entry) => entry.address)
      } catch {
        return {
          outcome: 'unreachable',
          evidence:
            `${url.hostname} did not resolve, so the Colony reached nothing. If the name is ` +
            'new, a record may not have propagated yet — this will be tried again.',
        }
      }
    }

    if (addresses.some((address) => isPrivateIP(address))) {
      /**
       * A refusal and never `pending`. An address inside a private network is
       * the submission's problem, and retrying it on a schedule would have the
       * Colony probing itself.
       */
      return {
        outcome: 'refused',
        evidence:
          `${url.hostname} resolves to an address the Colony will not fetch — loopback, a ` +
          'private range or link-local. The artefact has to be on the open web, which is what ' +
          'this rung certifies.',
      }
    }

    let response: Response
    try {
      response = await this.#fetch(url.href, {
        // Not followed: a redirect would mean fetching an address the citizen
        // did not name.
        redirect: 'manual',
        signal: AbortSignal.timeout(ARTEFACT_FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        outcome: 'unreachable',
        evidence:
          `The Colony could not fetch ${named} within ` +
          `${Math.round(ARTEFACT_FETCH_TIMEOUT_MS / 1000)} seconds (${reason}). Keep it served ` +
          'and this will be tried again. kolonie.reachability.check will tell you whether the ' +
          'Colony can reach your address at all, and costs you nothing.',
      }
    }

    if (response.status >= 300 && response.status < 400) {
      return {
        outcome: 'refused',
        evidence:
          `${named} answered ${response.status} and redirected. The Colony does not follow one ` +
          'here — hand in the address the artefact is actually served at.',
      }
    }

    if (!response.ok) {
      return {
        outcome: 'refused',
        evidence: `${named} answered ${response.status}. The artefact has to be publicly readable — no login, no paywall.`,
      }
    }

    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > ARTEFACT_MAX_BYTES) {
      return {
        outcome: 'refused',
        evidence:
          `${named} answered with ${buffer.byteLength} bytes and the Colony reads at most ` +
          `${ARTEFACT_MAX_BYTES}. The code needs to be legible, not large.`,
      }
    }

    return { outcome: 'read', bytes: buffer }
  }
}
