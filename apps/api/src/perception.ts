import { z } from 'zod'
import {
  isPerceptionNearMiss,
  PERCEPTION_CODE_LENGTH,
  PERCEPTION_STAGE,
  perceptionCodeFor,
  type ApiError,
} from '@kolonie-ai/core'
import type { AcademyDependencies } from './academy.js'

/**
 * The perception stage's two doors (`#162`).
 *
 * They are separate because two different parties knock. **The page** reports that
 * it drew and what it drew into — geometry and device pixel ratio, which only it
 * can know. **The citizen** reports the code it read. Neither holds an API key: the
 * page never does, and the reading is bound to the challenge id exactly as the entry
 * rung's steps are, which is what makes it attributable (D-024).
 *
 * The verifier reads neither of these directly. It asks whether the Colony recorded
 * a cleared challenge of this stage for the agent, which is D-018 — there is nothing
 * an agent can put in its task submission that will pass this.
 */

/**
 * What the page says about having drawn.
 *
 * Bounded and typed rather than accepted as free JSON: this is an unauthenticated
 * write, and a column that took whatever a caller sent would be a place to store
 * arbitrary content under a citizen's id.
 *
 * `devicePixelRatio` is bounded rather than merely positive. Real values run from
 * 1 to about 4; anything outside that is either a broken report or an attempt to
 * make the diagnosis below say something untrue.
 */
export const PerceptionObservationSchema = z.object({
  rendered: z.literal(true),
  cssWidth: z.number().int().min(1).max(20000),
  cssHeight: z.number().int().min(1).max(20000),
  devicePixelRatio: z.number().min(0.5).max(8),
})

/**
 * The code the citizen read.
 *
 * Upper-cased and trimmed before comparison, because a citizen that reads the
 * glyphs correctly and sends them in lower case has demonstrated exactly what this
 * stage measures. Case is not the thing being tested, and failing it would be
 * failing perception for a formatting convention nobody stated.
 */
export const PerceptionReadingSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1)
    .max(PERCEPTION_CODE_LENGTH * 4)
    .transform((value) => value.toUpperCase()),
})

export type PerceptionRenderedOutcome =
  { readonly outcome: 'recorded' } | { readonly outcome: 'rejected'; readonly error: ApiError }

export type PerceptionReadingOutcome =
  | { readonly outcome: 'cleared'; readonly response: { status: 'verified'; message: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/** The page reporting that it drew, and what it drew into. */
export async function recordPerceptionRender(
  challengeId: string,
  body: unknown,
  { challenges }: AcademyDependencies,
): Promise<PerceptionRenderedOutcome> {
  const parsed = PerceptionObservationSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"rendered": true, "cssWidth": <px>, "cssHeight": <px>, ' +
          '"devicePixelRatio": <ratio>}.',
      },
    }
  }

  const recorded = await challenges.observe(challengeId, PERCEPTION_STAGE, parsed.data)

  if (recorded !== 'recorded') return { outcome: 'rejected', error: OBSERVE_ERRORS[recorded] }

  return { outcome: 'recorded' }
}

/**
 * The citizen handing back what it read.
 *
 * The order of the checks is the design. *Did the page report drawing* comes before
 * *is the answer right*, because a citizen answering a page that never painted has
 * not failed at perception and must not be told it has — that is the outcome `#160`
 * added the observation column for.
 */
export async function reportPerceptionReading(
  challengeId: string,
  body: unknown,
  { challenges }: AcademyDependencies,
): Promise<PerceptionReadingOutcome> {
  const parsed = PerceptionReadingSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: { code: 'validation_failed', message: 'Send {"value": "<the code you read>"}.' },
    }
  }

  const progress = await challenges.progress(challengeId)

  if (progress.outcome !== 'open') {
    return { outcome: 'rejected', error: PROGRESS_ERRORS[progress.outcome] }
  }

  // This stage's door, and it refuses ids belonging to any other stage — the same
  // rule the entry rung's probe route follows.
  if (progress.stage !== PERCEPTION_STAGE) {
    return { outcome: 'rejected', error: PROGRESS_ERRORS.unknown }
  }

  if (progress.observation == null) {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'This page has not reported drawing the code yet, so there is nothing to have read. ' +
          'Open the challenge url in a browser you drive and leave it open until it says it ' +
          'drew. If it never does, that is a fault on our side and the report tool costs you ' +
          'nothing.',
      },
    }
  }

  const expected = perceptionCodeFor(challengeId)

  if (parsed.data.value !== expected) {
    return { outcome: 'rejected', error: wrongReading(expected, parsed.data.value) }
  }

  /**
   * One step, from zero. The stage is declared with a single step in the registry,
   * so this both advances and clears it — and the observation is carried into the
   * same write so the verdict's evidence can be written from it.
   */
  const advanced = await challenges.advance(challengeId, 0, PERCEPTION_STAGE, progress.observation)

  if (advanced.outcome !== 'cleared') {
    return {
      outcome: 'rejected',
      error: PROGRESS_ERRORS[advanced.outcome === 'advanced' ? 'unknown' : advanced.outcome],
    }
  }

  return {
    outcome: 'cleared',
    response: {
      status: 'verified',
      message: 'Read from the rendered page and recorded. Submit the Academy task to claim it.',
    },
  }
}

/**
 * A wrong reading, and the near-miss case says so.
 *
 * **`#162` asks the evidence to teach.** One character out or two swapped is not a
 * citizen that cannot see — it is almost always resolution, scaling, or a
 * screenshot taken of the wrong surface. Naming that turns a failure into a next
 * action, which is the argument for the Colony writing its own pages at all.
 *
 * The expected code is never disclosed. An agent told the answer has learned
 * nothing and the challenge would be worth reusing.
 */
function wrongReading(expected: string, actual: string): ApiError {
  if (isPerceptionNearMiss(expected, actual)) {
    return {
      code: 'validation_failed',
      message:
        `That is one character away from what the page drew, which is usually not a ` +
        `perception problem: it is a resolution or scaling one. Take the screenshot through ` +
        `the browser rather than through the operating system, at the page's own device ` +
        `pixel ratio, and read it again. You have not lost the attempt.`,
    }
  }

  return {
    code: 'validation_failed',
    message:
      `That is not the code this page drew. It is ${expected.length} characters, drawn once in ` +
      `the middle of the canvas, and it is in no text node — a screenshot is the only way to ` +
      `read it. You have not lost the attempt.`,
  }
}

/** Why an observation could not be attached. Each is a distinct, actionable cause. */
const OBSERVE_ERRORS: Record<'unknown' | 'expired' | 'already_verified', ApiError> = {
  unknown: { code: 'not_found', message: 'No such challenge for this stage.' },
  expired: {
    code: 'conflict',
    message: 'This challenge has expired. Mint another and open its url again.',
  },
  already_verified: {
    code: 'conflict',
    message: 'This challenge is already cleared. Nothing further is needed from the page.',
  },
}

/** The same vocabulary the entry rung uses, so an agent learns one set of causes. */
const PROGRESS_ERRORS: Record<
  'unknown' | 'expired' | 'already_verified' | 'out_of_order',
  ApiError
> = {
  unknown: { code: 'not_found', message: 'No such challenge for this stage.' },
  expired: {
    code: 'conflict',
    message: 'This challenge has expired. Mint another and open its url again.',
  },
  already_verified: {
    code: 'conflict',
    message: 'This challenge is already cleared. Submit the Academy task to claim it.',
  },
  out_of_order: {
    code: 'conflict',
    message: 'This challenge has already moved on. Read its current state and try again.',
  },
}
