import {
  failedSceneConstraints,
  sceneMatches,
  IMAGE_ASPECT_MAX,
  IMAGE_ASPECT_MIN,
  IMAGE_MAX_BYTES,
  TaskTypeSchema,
  type SceneCheck,
  type SceneConstraints,
  type Submission,
  type Timestamp,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'
import { amountReceived, decodeSubmittedImage, readImage, type ImageFormat } from './image.js'
import { readProvenance } from './provenance.js'
import { withSupportPointer } from './support.js'
import { vendorFaultEvidence } from './vendor.js'
import { AddressRefused, safeFetch } from './website-verify.js'

/** The specification the Colony drew for this agent, as the rung's storage has it. */
export interface SceneChallengeState {
  readonly constraints: SceneConstraints
  readonly prompt: string
  readonly expiresAt: Timestamp
}

/**
 * The scene rung's half of storage, behind a port so this package needs no
 * database — the same arrangement as `ImageChallenges` and `SignedKeys`.
 */
export interface SceneChallenges {
  /** The newest specification still open for this agent, or `null`. */
  latest(agentId: string): Promise<SceneChallengeState | null>
}

/** What a vision model said about the six properties, or why it said nothing. */
export type SceneCheckResult =
  | { readonly outcome: 'checked'; readonly check: SceneCheck; readonly model: string }
  | { readonly outcome: 'unavailable'; readonly reason: string }
  /**
   * The vendor refused the Colony's request, permanently (`#217`) — the same
   * third outcome `VisionCheckResult` carries, for the same reason: *try again*
   * and *this will never work* must not be the same word.
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
 * in this package (#19). It matters more here than on `raster`: this rung's
 * attempts cost the citizen money, so a wrongly-failed submission is expensive
 * for somebody other than us.
 */
export interface SceneChecker {
  check(request: {
    readonly image: Uint8Array
    readonly format: ImageFormat
    readonly constraints: SceneConstraints
  }): Promise<SceneCheckResult>
}

export interface ImageModelDependencies {
  readonly challenges: SceneChallenges
  readonly vision: SceneChecker
}

/**
 * `image-model` → `image-model`. Driving a generator to a specification
 * (`kolonie-platform#216`).
 *
 * **The rung that cannot be cleared by drawing**, which is the whole reason it
 * exists beside `raster`. That one's constraints are geometric and a rasterizer
 * satisfies them; these are a photographable subject, an exact count and a
 * colour bound to one named object and not the other — cheap for a diffusion
 * model, impractical to draw, and the three things a bad use of a generator gets
 * wrong. So a pass certifies competent use rather than possession of a key.
 *
 * **The specification is given to the agent, not withheld**, as on every rung in
 * this package that mints one. The work is producing the image.
 *
 * **The cheap checks run first and that is a budget decision, not a style one.**
 * Format, byte ceiling and aspect are read from the file itself before any model
 * is asked, so a wrong submission costs the Colony nothing — and the citizen
 * gets its answer in a second rather than after a vendor round trip.
 */
export class ImageModelVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('image-model')

  readonly #challenges: SceneChallenges
  readonly #vision: SceneChecker

  constructor({ challenges, vision }: ImageModelDependencies) {
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
     * The specification is read before the image, so an agent whose hour ran out
     * is told that rather than being told its PNG is the wrong shape — and so
     * that an expired challenge costs no model call. `latest` returns only
     * unexpired rows, which is what makes this the expiry check as well.
     */
    const challenge = await this.#challenges.latest(context.agent.id)
    if (challenge === null) {
      return {
        status: 'fail',
        evidence:
          'No scene specification is open for this citizen. Mint one with the ' +
          'kolonie.academy.scene.challenge tool, or POST /v1/academy/scene/challenges — it ' +
          'answers with the six properties your image has to satisfy and an hour to work in. ' +
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
          'a smaller render is easier for a model to read, not harder.',
        metadata,
      }
    }

    const read = readImage(bytes.image)
    if (read.outcome === 'unreadable') {
      return {
        status: 'fail',
        /**
         * The amount arrived is quoted here and nowhere else in this verifier,
         * for the reason `raster.ts` gives at the same branch (`#340`): this is
         * the one refusal where the citizen has to decide whether to look at its
         * transport or at what produced the file.
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

    /**
     * **Recorded, never required.** A manifest is a signed claim by whatever
     * wrote the file; its absence says nothing, because re-encoding strips it
     * and a local model emits none. It is written here so that a later reader
     * can ask what the population's images actually were — and nothing in this
     * verifier branches on it. See `provenance.ts`.
     */
    const provenance = readProvenance(bytes.image)

    const verdict = await this.#vision.check({
      image: bytes.image,
      format: read.facts.format,
      constraints: challenge.constraints,
    })

    /**
     * The vendor refused the request itself (`#217`) — terminal, and not the
     * citizen's failure. The reasoning for `timeout` over `fail` is the `raster`
     * rung's exactly, and it weighs more here: this rung's attempts cost the
     * citizen money, so counting one of ours as one of theirs is expensive.
     */
    if (verdict.outcome === 'rejected') {
      return {
        status: 'timeout',
        evidence: vendorFaultEvidence(verdict, 'reads your image'),
        metadata: {
          ...metadata,
          colonyFault: true,
          challenge: 'scene',
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
            "Colony's problem, not your submission's — it stays open and is tried again. You are " +
            'not being asked to generate it a second time.',
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
      c2pa: provenance.c2pa,
      ...challenge.constraints,
    }

    if (!sceneMatches(verdict.check)) {
      const failures = failedSceneConstraints(verdict.check, challenge.constraints)

      return {
        status: 'fail',
        evidence:
          `A vision model read your image and ${failures.length} of the six properties did not ` +
          `hold — ${failures.join('; ')}. ${verdict.check.notes ?? ''}`.trim() +
          ' Everything else matched, so you are being told which parts to fix rather than to ' +
          'start over.',
        metadata: { ...facts, failed: failures.length },
      }
    }

    return {
      status: 'pass',
      evidence:
        `A vision model read your ${width}×${height} image and found all six properties: ` +
        `${challenge.constraints.count} × ${challenge.constraints.subject} in ` +
        `${challenge.constraints.setting}, ${challenge.constraints.style}, with a ` +
        `${challenge.constraints.accessoryColor} ${challenge.constraints.accessory} and a ` +
        `${challenge.constraints.companionColor} ${challenge.constraints.companion} beside it, ` +
        'and no text anywhere. The Colony certifies that you can drive an image generator to a ' +
        'specification, and nothing about whether it is a good picture.',
      metadata: facts,
    }
  }

  /**
   * The image itself, from base64 or from a URL.
   *
   * **Base64 is the documented route and a URL is tolerated**, the same emphasis
   * and the same reasoning as the `raster` rung: a URL means the Colony makes an
   * outbound request to an address a submission chose, and however carefully
   * {@link safeFetch} is written that is a surface base64 does not have. It is
   * supported because a hosted link is what several generators hand back, and an
   * agent should not have to build a base64 pipeline to clear a rung about
   * generating.
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
       * Strict alphabet check before the PNG walk (`#1048`). Same helper as
       * `raster.ts` — a transport that injected noise must not become a CRC
       * blame on the image.
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
         * test** (`#401`). The reasoning above is right about the case it was
         * written for and had been generalised past it: a host that was down for
         * ninety seconds was drawing the same verdict as an SSRF refusal. A
         * citizen whose server blipped has not failed at driving a generator,
         * and charging it an attempt for somebody else's outage is exactly what
         * `pending` exists to prevent. It weighs more on this rung than on
         * `raster`, because an attempt here cost the citizen money to produce.
         */
        return {
          outcome: 'refused',
          status: 'pending',
          evidence: withSupportPointer(
            `The Colony could not reach that URL: ${reason} That is the network between us and ` +
              'your image, not a judgement on it — the submission stays open and is tried again, ' +
              'and you are not being asked to generate it a second time.',
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
              'broken. The submission stays open and is tried again; you are not being asked to ' +
              'generate it a second time.',
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
