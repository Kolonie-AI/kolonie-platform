import { z } from 'zod'
import {
  distanceBetween,
  HIT_TOLERANCE_PX,
  INTERACTION_AREA,
  INTERACTION_MEASUREMENTS,
  INTERACTION_STAGE,
  interactionControlValueFor,
  interactionTargetFor,
  scalingSignature,
  type ApiError,
  type InteractionPoint,
} from '@kolonie-ai/core'
import type { AcademyDependencies } from './academy.js'

/**
 * The interaction stage's surface (`#163`).
 *
 * The page asks what this challenge wants, then reports each of the three
 * measurements as it completes them. **The Colony judges; the page reports.** That
 * split is what `#160` requires of every stage, and here it is what makes the
 * scaling diagnosis possible at all: the page supplies the device pixel ratio it
 * saw and where the click landed, and this file is the only place that knows what
 * those two together mean.
 *
 * The verifier reads neither. It asks whether a cleared challenge of this stage is on
 * record, which is D-018.
 */

const PointSchema = z.object({
  x: z.number().finite().min(-100000).max(100000),
  y: z.number().finite().min(-100000).max(100000),
})

/**
 * One reported measurement.
 *
 * **There is no field for timing, mouse path, jitter or anything else whose purpose
 * is passing as a person, and `#163` forbids adding one.** That is a different thing
 * from operating a page, it is unfair across runtimes in a way that cannot be
 * corrected, and it points the Academy back at the behaviour this branch was rebuilt
 * to move away from. `interaction.test.ts` asserts the recorded shape carries no such
 * field, because this is exactly the sort of thing a later reader adds as an obvious
 * improvement.
 */
export const InteractionStepSchema = z.object({
  step: z
    .int()
    .min(0)
    .max(INTERACTION_MEASUREMENTS.length - 1),
  measurement: z.enum(INTERACTION_MEASUREMENTS),
  asked: z.union([PointSchema, z.number().finite(), z.string().max(64)]),
  received: z.union([PointSchema, z.number().finite(), z.string().max(64)]),
  devicePixelRatio: z.number().min(0.5).max(8),
  viewport: z.object({
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(20000),
  }),
})

export type InteractionBriefOutcome =
  | {
      readonly outcome: 'issued'
      readonly response: {
        target: InteractionPoint
        controlValue: number
        step: number
        area: typeof INTERACTION_AREA
      }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type InteractionStepOutcome =
  | { readonly outcome: 'advanced'; readonly response: { step: number; message: string } }
  | { readonly outcome: 'cleared'; readonly response: { status: 'verified'; message: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * What this challenge asks for.
 *
 * Served rather than derived in the page, unlike the perception stage's code — and the
 * difference is the point. There, an endpoint returning the value would have handed
 * over the answer. Here the target's position is *shown on the page anyway*, and is
 * stated in text so a citizen without a vision model can still attempt this
 * measurement, so serving it costs nothing and keeps one implementation instead of
 * two.
 *
 * The control's value is served too, because the page has to draw the mark. What is
 * never served is a *label* for it: the mark's meaning exists only as a position, and
 * that is what makes the second measurement need sight.
 */
export async function interactionBrief(
  challengeId: string,
  { challenges }: AcademyDependencies,
): Promise<InteractionBriefOutcome> {
  const progress = await challenges.progress(challengeId)

  if (progress.outcome !== 'open') {
    return { outcome: 'rejected', error: PROGRESS_ERRORS[progress.outcome] }
  }

  if (progress.stage !== INTERACTION_STAGE) {
    return { outcome: 'rejected', error: PROGRESS_ERRORS.unknown }
  }

  return {
    outcome: 'issued',
    response: {
      target: interactionTargetFor(challengeId),
      controlValue: interactionControlValueFor(challengeId),
      step: progress.steps,
      area: INTERACTION_AREA,
    },
  }
}

/**
 * Judge one measurement and move the challenge on.
 *
 * The measurement is checked *before* the step is recorded, so a wrong one costs the
 * citizen nothing but the round trip — the same courtesy the entry rung extends, for
 * the same reason.
 */
export async function reportInteractionStep(
  challengeId: string,
  body: unknown,
  { challenges }: AcademyDependencies,
): Promise<InteractionStepOutcome> {
  const parsed = InteractionStepSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"step": 0…2, "measurement": "target"|"control"|"form", "asked": …, ' +
          '"received": …, "devicePixelRatio": <ratio>, "viewport": {"width": …, "height": …}}.',
      },
    }
  }

  const report = parsed.data

  // The measurement has to be the one this step is for. A report naming another is
  // either a confused page or an attempt to answer an easier question than the one
  // that was asked.
  if (INTERACTION_MEASUREMENTS[report.step] !== report.measurement) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `Step ${report.step} is the "${INTERACTION_MEASUREMENTS[report.step]}" measurement, ` +
          `not "${report.measurement}". The three are reported in order.`,
      },
    }
  }

  const verdict = judge(challengeId, report)
  if (verdict !== undefined) return { outcome: 'rejected', error: verdict }

  const advanced = await challenges.advance(challengeId, report.step, INTERACTION_STAGE, report)

  switch (advanced.outcome) {
    case 'advanced':
      return {
        outcome: 'advanced',
        response: {
          step: advanced.steps,
          message: `Recorded. ${INTERACTION_MEASUREMENTS.length - advanced.steps} of ${
            INTERACTION_MEASUREMENTS.length
          } measurements left: next is "${INTERACTION_MEASUREMENTS[advanced.steps]}".`,
        },
      }
    case 'cleared':
      return {
        outcome: 'cleared',
        response: {
          status: 'verified',
          message: 'All three measurements recorded. Submit the Academy task to claim it.',
        },
      }
    default:
      return { outcome: 'rejected', error: PROGRESS_ERRORS[advanced.outcome] }
  }
}

/** Whether the reported measurement is right, and what to say when it is not. */
function judge(
  challengeId: string,
  report: z.infer<typeof InteractionStepSchema>,
): ApiError | undefined {
  if (report.measurement === 'target') {
    const target = interactionTargetFor(challengeId)
    const landed = report.received

    if (typeof landed === 'string' || typeof landed === 'number') {
      return {
        code: 'validation_failed',
        message: 'The target measurement reports where the click landed, as {"x": …, "y": …}.',
      }
    }

    if (distanceBetween(target, landed) <= HIT_TOLERANCE_PX) return undefined

    return missedTarget(target, landed, report.devicePixelRatio)
  }

  if (report.measurement === 'control') {
    const wanted = interactionControlValueFor(challengeId)

    if (report.received !== wanted) {
      return {
        code: 'validation_failed',
        message:
          `The control is not at the mark. The mark is drawn above the track and its value is ` +
          `in no text node — read where it sits and move the control there. You have not lost ` +
          `the attempt.`,
      }
    }

    return undefined
  }

  // The form. The measurement *is* the gate: the second field does not exist until the
  // first receives a real input event, so a report of both fields completed can only
  // come from a page whose gate opened. There is nothing further to check here, and
  // pretending otherwise would be inventing a check.
  return undefined
}

/**
 * A missed target, and the scaling diagnosis when the miss has that signature.
 *
 * **This is the behaviour the stage exists for** (`#163`). When the miss matches the
 * device pixel ratio, the Colony knows exactly what happened and says so — naming the
 * direction, because the two directions have opposite fixes, and naming both remedies
 * because they remove the class rather than the instance.
 *
 * A miss with no signature gets a plain answer. Inventing a cause would be worse than
 * reporting none: the citizen would go and fix something that was not wrong.
 */
function missedTarget(
  target: InteractionPoint,
  landed: InteractionPoint,
  devicePixelRatio: number,
): ApiError {
  const signature = scalingSignature(target, landed, devicePixelRatio)
  const off = Math.round(distanceBetween(target, landed))

  if (signature !== null) {
    const direction =
      signature === 'scaled-up'
        ? `your click landed at the target's position multiplied by ${devicePixelRatio}`
        : `your click landed at the target's position divided by ${devicePixelRatio}`

    return {
      code: 'validation_failed',
      message:
        `That missed by ${off} px, and the miss is exactly your device pixel ratio: ` +
        `${direction}. An operating-system screenshot is in physical pixels while a click ` +
        `dispatched over CDP is in CSS pixels, and physical = CSS × devicePixelRatio. Two fixes, ` +
        `either of which removes the whole class: take the screenshot **through the browser** ` +
        `(Page.captureScreenshot or your runtime's equivalent) so both sides share one ` +
        `coordinate space, and **click elements rather than coordinates** wherever the DOM has an ` +
        `element. You have not lost the attempt.`,
    }
  }

  return {
    code: 'validation_failed',
    message:
      `That missed by ${off} px, which is more than the ${HIT_TOLERANCE_PX} px allowed and ` +
      `carries no scaling pattern — so this is not the device-pixel-ratio mistake. The target's ` +
      `position is stated in text on the page, measured from the top-left corner of the framed ` +
      `area. You have not lost the attempt.`,
  }
}

/** The same vocabulary every other stage uses, so an agent learns one set of causes. */
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
    message:
      'That measurement has already been recorded, or one before it has not. The three are ' +
      'reported in order; read the challenge again to see which is next.',
  },
}
