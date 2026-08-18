import {
  failedConstraints,
  imageMatches,
  IMAGE_ASPECT_MAX,
  IMAGE_ASPECT_MIN,
  IMAGE_MAX_BYTES,
  TaskTypeSchema,
  type ImageCheck,
  type ImageConstraints,
  type Submission,
  type Timestamp,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'
import { amountReceived, decodeSubmittedImage, readImage, type ImageFormat } from './image.js'
import { withSupportPointer } from './support.js'
import { vendorFaultEvidence } from './vendor.js'
import { AddressRefused, safeFetch } from './website-verify.js'

/** The specification the Colony drew for this agent, as the rung's storage has it. */
export interface ImageChallengeState {
  readonly constraints: ImageConstraints
  readonly prompt: string
  readonly expiresAt: Timestamp
}

/**
 * The image rung's half of storage, behind a port so this package needs no
 * database — the same arrangement as `SignedKeys` and `ClearedGates`.
 */
export interface ImageChallenges {
  /** The newest specification still open for this agent, or `null`. */
  latest(agentId: string): Promise<ImageChallengeState | null>
}

/** What a vision model said about the five constraints, or why it said nothing. */
export type VisionCheckResult =
  | { readonly outcome: 'checked'; readonly check: ImageCheck; readonly model: string }
  | { readonly outcome: 'unavailable'; readonly reason: string }
  /**
   * The vendor refused the Colony's request, permanently (`#217`).
   *
   * **Apart from `unavailable`, because the two mean opposite things to the
   * runner**: that one is *ask again in thirty seconds*, this one is *asking
   * again produces the same answer*. Collapsing them is the defect — a 400 read
   * as `unavailable` was retried 1829 times for one submission.
   */
  | {
      readonly outcome: 'rejected'
      readonly reason: string
      readonly status: number
      readonly body: string
    }

/**
 * The seam the rung's judgement arrives through, so its tests need no model.
 *
 * **Two outcomes, and `unavailable` is the one that matters.** A model that was
 * rate-limited, out of credit or down said nothing about the image — and
 * reporting that as *"your image does not match"* would fail an agent that did
 * the work, for our budget. It becomes `pending`, like every other outward read
 * in this package (#19).
 */
export interface VisionChecker {
  check(request: {
    readonly image: Uint8Array
    readonly format: ImageFormat
    readonly constraints: ImageConstraints
  }): Promise<VisionCheckResult>
}

export interface RasterDependencies {
  readonly challenges: ImageChallenges
  readonly vision: VisionChecker
}

/**
 * `raster` → `raster`. Producing a picture to a specification
 * (`kolonie-platform#60`, renamed from `image-gen` by `#215`).
 *
 * **It is the mirror of `vision-capability` and not a duplicate of it.** That
 * rung certifies an agent can read an image; this one that it can make one. The
 * two are separable — plenty of runtimes can see and not draw — which is why
 * this grants a skill of its own rather than reusing `vision`.
 *
 * **What it certifies is drawing, and the name now says so.** The five
 * constraints are geometric, so a rasterizer satisfies them and no generator is
 * needed — measured over the first ten submissions, 8 were drawn. Nothing about
 * the check changed with the rename; what changed is that the skill no longer
 * claims a capability the Colony never read. The rung that does require a
 * generator is `image-model` (`#216`), and it has its own verifier.
 *
 * **The specification is given to the agent, not withheld.** The challenge
 * endpoint returns the constraints as well as the prompt, so there is nothing to
 * guess: the work is generating an image that matches five stated properties,
 * and a rung that hid them would be measuring luck. It is also what makes the
 * evidence useful — an agent that fails is told which of the five went wrong.
 *
 * **What is checked is not what the agent claims it sent.** The format is read
 * from the file's own header (D-018), which matters more here than usual: these
 * bytes are about to be handed to a vendor's model as a data URL, under whatever
 * type we believed.
 */
export class RasterVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('raster')

  readonly #challenges: ImageChallenges
  readonly #vision: VisionChecker

  constructor({ challenges, vision }: RasterDependencies) {
    this.#challenges = challenges
    this.#vision = vision
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const metadata = { attempt: submission.attempt }
    const payload = submission.payload as {
      image?: unknown
      imageUrl?: unknown
    } | null

    /**
     * The specification is read before the image, so an agent that never minted
     * one is told that rather than being told its PNG is the wrong shape.
     */
    const challenge = await this.#challenges.latest(context.agent.id)
    if (challenge === null) {
      return {
        status: 'fail',
        evidence:
          'No image specification is open for this citizen. Mint one with the ' +
          'kolonie.academy.image.challenge tool, or POST /v1/academy/image/challenges — it ' +
          'answers with the five constraints your image has to satisfy and an hour to work in. ' +
          'A specification that has run out is the same as never having had one: mint another.',
        metadata,
      }
    }

    const bytes = await this.#bytesFrom(payload)
    if (bytes.outcome !== 'read') {
      return { status: bytes.status, evidence: bytes.evidence, metadata }
    }

    if (bytes.image.byteLength > IMAGE_MAX_BYTES) {
      return {
        status: 'fail',
        evidence:
          `That image is ${(bytes.image.byteLength / 1024 / 1024).toFixed(1)}MB and the limit is ` +
          `${IMAGE_MAX_BYTES / 1024 / 1024}MB. Nothing this rung asks for needs a large image — ` +
          'a small square is easier for a model to read, not harder.',
        metadata,
      }
    }

    const read = readImage(bytes.image)
    if (read.outcome === 'unreadable') {
      return {
        status: 'fail',
        /**
         * **The amount is quoted here and nowhere else in this verifier** (`#340`).
         *
         * This is the branch a cut short arrives in, and it is the only one where
         * the citizen has to decide whether to look at its transport or at its
         * encoder. Every other refusal below is about a picture that arrived
         * whole and is the wrong picture, where the number is noise.
         */
        evidence:
          `The submission could not be read: ${read.reason} The Colony received ` +
          `${bytes.arrival} — if that is not what you sent, whatever carried the payload ` +
          'altered it, and the fault is not in what you drew.',
        metadata,
      }
    }

    const { width, height } = read.facts
    const ratio = height === 0 ? 0 : width / height

    if (ratio < IMAGE_ASPECT_MIN || ratio > IMAGE_ASPECT_MAX) {
      return {
        status: 'fail',
        evidence:
          `That image is ${width}×${height}, a ratio of ${ratio.toFixed(2)}, and the ` +
          'specification asks for a square. This is checked before the image is looked at, so ' +
          'it costs you nothing to fix and resubmit.',
        metadata: { ...metadata, width, height },
      }
    }

    const verdict = await this.#vision.check({
      image: bytes.image,
      format: read.facts.format,
      constraints: challenge.constraints,
    })

    /**
     * The vendor refused the request itself, so retrying is pointless (`#217`).
     *
     * **`timeout` rather than `fail`**, and the difference is the citizen's
     * record: `fail` closes the attempt as this agent's failure and raises the
     * rung's failure rate, for something the agent did not do. `timeout` is
     * terminal — the loop stops — and `recordVerdict` deliberately leaves the
     * attempt open on it, which is exactly *the Colony could not serve this*.
     */
    if (verdict.outcome === 'rejected') {
      return {
        status: 'timeout',
        evidence: vendorFaultEvidence(verdict, 'reads your image'),
        metadata: {
          ...metadata,
          colonyFault: true,
          challenge: 'image',
          vendorStatus: verdict.status,
          vendorBody: verdict.body,
        },
      }
    }

    if (verdict.outcome === 'unavailable') {
      return {
        status: 'pending',
        evidence: withSupportPointer(
          `The Colony could not have your image looked at: ${verdict.reason} This is the ` +
            "Colony's problem, not your submission's — it stays open and is tried again.",
        ),
        metadata,
      }
    }

    const facts = {
      ...metadata,
      width,
      height,
      format: read.facts.format,
      model: verdict.model,
      ...challenge.constraints,
    }

    if (!imageMatches(verdict.check)) {
      const failures = failedConstraints(verdict.check, challenge.constraints)

      return {
        status: 'fail',
        evidence:
          `A vision model read your image and ${failures.length} of the five constraints did not ` +
          `hold: ${failures.join('; ')}. ${verdict.check.notes ?? ''}`.trim() +
          ' Everything else matched — you are being told which parts to fix rather than to start over.',
        metadata: { ...facts, failed: failures.length },
      }
    }

    return {
      status: 'pass',
      evidence:
        `A vision model read your ${width}×${height} image and found all five constraints: a ` +
        `${challenge.constraints.shapeColor} ${challenge.constraints.shape} at ` +
        `${challenge.constraints.position} on a ${challenge.constraints.background} background, ` +
        `with ${challenge.constraints.secondary === 'none' ? 'nothing else' : challenge.constraints.secondary}. ` +
        'The Colony certifies that you can produce an image to a specification, and nothing ' +
        'about whether it is a good picture or how the pixels were made.',
      metadata: facts,
    }
  }

  /**
   * The image itself, from base64 or from a URL.
   *
   * **Base64 is the documented route and a URL is tolerated**, which is the
   * opposite emphasis from most of this package. A URL means the Colony makes an
   * outbound request to an address a submission chose, and however carefully
   * {@link safeFetch} is written that is a surface base64 simply does not have.
   * It is supported because an agent whose generator hands back a hosted link
   * should not have to build a base64 pipeline to clear a rung about drawing —
   * but the instructions lead with base64 and so does this.
   */
  async #bytesFrom(payload: { image?: unknown; imageUrl?: unknown } | null): Promise<
    | {
        readonly outcome: 'read'
        readonly image: Uint8Array
        /** How much arrived, for a message that has to say so (`#340`). */
        readonly arrival: string
      }
    | {
        readonly outcome: 'refused'
        readonly status: 'fail' | 'pending'
        readonly evidence: string
      }
  > {
    if (typeof payload?.image === 'string' && payload.image !== '') {
      /**
       * Strict alphabet check before the PNG walk (`#1048`). `Buffer.from` would
       * otherwise silently skip noise a transport injected, and the CRC path would
       * then blame the image. `decodeSubmittedImage` names the string and points
       * at `imageUrl`.
       */
      const decoded = decodeSubmittedImage(payload.image)

      if (decoded.outcome === 'refused') {
        return {
          outcome: 'refused',
          status: 'fail',
          evidence: decoded.reason,
        }
      }

      return {
        outcome: 'read',
        image: decoded.bytes,
        arrival: amountReceived({
          characters: decoded.characters,
          bytes: decoded.bytes.byteLength,
        }),
      }
    }

    if (typeof payload?.imageUrl === 'string' && payload.imageUrl !== '') {
      let url: URL
      try {
        url = new URL(payload.imageUrl)
      } catch {
        return { outcome: 'refused', status: 'fail', evidence: '"imageUrl" is not a URL.' }
      }

      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return {
          outcome: 'refused',
          status: 'fail',
          evidence: '"imageUrl" has to be an http or https address.',
        }
      }

      let response: Response
      try {
        response = await safeFetch(url.href)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)

        /**
         * An address that resolves inside our network is the submission's
         * problem and is refused outright — it must never become `pending`,
         * which would have the Colony retry an attempt on itself on a schedule.
         */
        if (error instanceof AddressRefused) {
          return {
            outcome: 'refused',
            status: 'fail',
            evidence: `That URL could not be fetched: ${reason}`,
          }
        }

        /**
         * **Everything else is the network, and the network is not a capability
         * test** (`#401`). `could not reach it` is `pending` and `it was wrong`
         * is `fail` everywhere else in the Colony, and this branch had collapsed
         * the two: a citizen whose host was down for ninety seconds was told its
         * drawing had failed.
         */
        return {
          outcome: 'refused',
          status: 'pending',
          evidence: withSupportPointer(
            `The Colony could not reach that URL: ${reason} That is the network between us and ` +
              'your image, not a judgement on it — the submission stays open and is tried again.',
          ),
        }
      }

      /**
       * A `5xx` is the host saying it is broken, which is the same ninety
       * seconds as a refused connection; a `404` is the host answering that
       * there is no such image, which is an answer about the submission.
       */
      if (response.status >= 500) {
        return {
          outcome: 'refused',
          status: 'pending',
          evidence: withSupportPointer(
            `That URL answered ${response.status}, so the host that has your image is currently ` +
              'broken. The submission stays open and is tried again.',
          ),
        }
      }

      if (!response.ok) {
        return {
          outcome: 'refused',
          status: 'fail',
          evidence: `That URL answered ${response.status}. The image has to be publicly reachable.`,
        }
      }

      const declared = response.headers.get('content-type') ?? ''
      if (!declared.toLowerCase().startsWith('image/')) {
        return {
          outcome: 'refused',
          status: 'fail',
          evidence: `That URL answered with Content-Type "${declared}", which is not an image.`,
        }
      }

      const fetched = new Uint8Array(await response.arrayBuffer())
      return { outcome: 'read', image: fetched, arrival: amountReceived({ bytes: fetched.length }) }
    }

    return {
      outcome: 'refused',
      status: 'fail',
      evidence:
        'This task is handed in with the image itself: the body ' +
        '{"payload": {"image": "<base64>"}}, or {"payload": {"imageUrl": "https://…"}} if your ' +
        'generator gives you a link. Neither was sent.',
    }
  }
}
