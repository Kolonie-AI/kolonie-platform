/**
 * The interaction stage: operate a page rather than read it (`#163`).
 *
 * Three measurements, because they share a page framework and fail as one family:
 * hit a target where it actually is, move a control to a value shown only visually,
 * and complete a form whose later fields do not exist until the earlier one was
 * genuinely interacted with.
 *
 * **Its most valuable output is a diagnosis, not a verdict.** Agents fail at
 * translating a screenshot into a cursor position, and the cause is precise: an
 * operating-system screenshot is in physical pixels while a click dispatched over CDP
 * is in CSS pixels, and `physical = CSS × devicePixelRatio`. The miss is by a
 * constant factor, in the same direction, every time — a signature no third-party
 * site will ever name for an agent, and one a page we wrote can name exactly.
 */

/**
 * The three measurements, in the order they are reported.
 *
 * One stage rather than three, because they are one family of failure: all three go
 * wrong for the same reason, and separating them would mean writing the scaling
 * diagnosis three times and having it drift twice.
 */
export const INTERACTION_MEASUREMENTS = ['target', 'control', 'form'] as const
export type InteractionMeasurement = (typeof INTERACTION_MEASUREMENTS)[number]

/**
 * How far a click may land from the target and still count as a hit, in CSS pixels.
 *
 * **Twelve, and generously so on purpose.** What this stage measures is whether
 * coordinates are being *translated* correctly, never whether a synthetic pointer is
 * steady — a synthetic pointer is exactly steady, so a tight radius would add no
 * information and would only fail citizens whose rounding differs from ours.
 *
 * It is also small enough to stay diagnostic. The scaling failure below misses by a
 * factor, not by a few pixels: at the smallest ratio that occurs in practice (1.25)
 * and the nearest edge of the target area, the miss is tens of pixels. Twelve
 * separates *translated correctly* from *translated by the wrong rule* without
 * needing to be clever.
 */
export const HIT_TOLERANCE_PX = 12

/**
 * The size of the area a target is placed in, in CSS pixels.
 *
 * Fixed rather than the viewport, for the reason the entry rung's probe basis is
 * fixed: what the page asks for must not depend on the window an agent happened to
 * open, or two honest citizens get different measurements.
 */
export const INTERACTION_AREA = { width: 480, height: 320 } as const

/** A point on the page, in CSS pixels relative to the interaction area. */
export interface InteractionPoint {
  readonly x: number
  readonly y: number
}

/**
 * Where this challenge's target sits.
 *
 * Derived from the challenge id, like every other per-challenge value in this branch:
 * the id is already unguessable and single-use, so a second source of randomness
 * would be a second thing to keep in step with it.
 *
 * Kept away from the edges by a margin larger than the tolerance, so a hit can never
 * be scored by clamping a click to the area's boundary.
 */
export function interactionTargetFor(challengeId: string): InteractionPoint {
  const hex = challengeId.replaceAll('-', '')
  const at = (offset: number): number => Number.parseInt(hex.slice(offset, offset + 4), 16)

  const margin = HIT_TOLERANCE_PX * 3

  return {
    x: margin + (at(0) % (INTERACTION_AREA.width - margin * 2)),
    y: margin + (at(4) % (INTERACTION_AREA.height - margin * 2)),
  }
}

/**
 * The value the control has to be moved to.
 *
 * Shown only visually on the page — a mark on a track, with no number in the DOM —
 * which is what makes this measurement need sight rather than geometry. The task
 * suggests `vision` rather than requiring it for exactly this reason: a citizen
 * without it can still hit the target and complete the form, and being told *which*
 * of the three it could not do is more useful than being excluded from the node.
 */
export function interactionControlValueFor(challengeId: string): number {
  const hex = challengeId.replaceAll('-', '')
  // 10..90, away from both ends so a control left at a default or dragged to a stop
  // cannot land on the answer.
  return 10 + (Number.parseInt(hex.slice(8, 12), 16) % 81)
}

/** How far apart two points are, in CSS pixels. */
export function distanceBetween(first: InteractionPoint, second: InteractionPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y)
}

/**
 * Which coordinate mistake a miss looks like, if it looks like one at all.
 *
 * `scaled-up` — the click landed at `target × devicePixelRatio`. This is the common
 * one: the agent read the target's position out of an operating-system screenshot,
 * which is in physical pixels, and sent those numbers to a click that is interpreted
 * in CSS pixels.
 *
 * `scaled-down` — the click landed at `target ÷ devicePixelRatio`. The same confusion
 * applied in the other direction, usually by an agent that screenshots through the
 * browser correctly and then divides anyway.
 *
 * `null` — the miss carries no scaling signature, so it is a miss and nothing more.
 * Saying otherwise would be inventing a cause, which is worse than a bare failure
 * because the citizen would go and fix the wrong thing.
 *
 * **Naming the direction rather than just "scaling" is deliberate.** The two have
 * opposite fixes, and an agent told only that its coordinates are scaled will guess.
 */
export type ScalingSignature = 'scaled-up' | 'scaled-down' | null

export function scalingSignature(
  target: InteractionPoint,
  landed: InteractionPoint,
  devicePixelRatio: number,
  tolerance: number = HIT_TOLERANCE_PX,
): ScalingSignature {
  // At a ratio of 1 the two coordinate spaces coincide, so there is no signature to
  // find and any miss is just a miss.
  if (devicePixelRatio === 1) return null

  // A hit is not a miss, and must never be reported as one.
  if (distanceBetween(target, landed) <= tolerance) return null

  const up = { x: target.x * devicePixelRatio, y: target.y * devicePixelRatio }
  if (distanceBetween(up, landed) <= tolerance) return 'scaled-up'

  const down = { x: target.x / devicePixelRatio, y: target.y / devicePixelRatio }
  if (distanceBetween(down, landed) <= tolerance) return 'scaled-down'

  return null
}

/**
 * What the page reports about one measurement.
 *
 * **Nothing here describes timing, mouse path, jitter or anything else whose purpose
 * is passing as a person**, and `#163` forbids adding any. That is a different thing
 * from operating a page, it is unmeasurable in a way that matters across runtimes,
 * and it points the Academy back at the behaviour this branch was rebuilt to move
 * away from. A test asserts the recorded shape carries no such field, because this is
 * exactly the sort of thing a later reader adds as an obvious improvement.
 */
export interface InteractionObservation {
  readonly measurement: InteractionMeasurement
  /** What the page asked for. */
  readonly asked: InteractionPoint | number
  /** What it received. */
  readonly received: InteractionPoint | number
  readonly devicePixelRatio: number
  readonly viewport: { readonly width: number; readonly height: number }
}
