import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  distanceBetween,
  HIT_TOLERANCE_PX,
  INTERACTION_AREA,
  interactionControlValueFor,
  interactionTargetFor,
  scalingSignature,
} from './interaction.js'

const AN_ID = '0f2c48a1-9b7e-4d3f-8a62-15c9de704b83'
const ANOTHER_ID = '7d61b204-3ac8-4e15-9f70-2b84ca6d0e19'

describe('where the target sits', () => {
  it('is deterministic per challenge and different between challenges', () => {
    expect(interactionTargetFor(AN_ID)).toEqual(interactionTargetFor(AN_ID))
    expect(interactionTargetFor(AN_ID)).not.toEqual(interactionTargetFor(ANOTHER_ID))
  })

  /**
   * **Kept away from the edges by more than the tolerance.** Otherwise a click
   * clamped to the area's boundary — which is what a broken coordinate translation
   * often produces — could score a hit by accident, and the measurement would pass
   * for the wrong reason.
   */
  it('never sits within tolerance of an edge', () => {
    for (const id of [AN_ID, ANOTHER_ID, 'ffffffff-ffff-4fff-8fff-ffffffffffff']) {
      const target = interactionTargetFor(id)

      expect(target.x).toBeGreaterThan(HIT_TOLERANCE_PX)
      expect(target.y).toBeGreaterThan(HIT_TOLERANCE_PX)
      expect(target.x).toBeLessThan(INTERACTION_AREA.width - HIT_TOLERANCE_PX)
      expect(target.y).toBeLessThan(INTERACTION_AREA.height - HIT_TOLERANCE_PX)
    }
  })
})

describe('the value the control must reach', () => {
  it('stays away from both ends, so a control left alone cannot be right', () => {
    for (const id of [AN_ID, ANOTHER_ID, '00000000-0000-4000-8000-000000000000']) {
      const value = interactionControlValueFor(id)

      expect(value).toBeGreaterThanOrEqual(10)
      expect(value).toBeLessThanOrEqual(90)
    }
  })
})

/**
 * **The behaviour this stage exists for.** `#163` requires the scaling diagnosis to
 * be a required behaviour rather than a nice-to-have, and these are the cases that
 * keep it from regressing silently.
 */
describe('the coordinate-scaling signature', () => {
  const target = { x: 200, y: 100 }

  it('names the common mistake: physical pixels sent to a CSS-pixel click', () => {
    // The agent read the target out of an operating-system screenshot at 1.5×, so it
    // clicked at 1.5 times the CSS position.
    const landed = { x: 300, y: 150 }

    expect(scalingSignature(target, landed, 1.5)).toBe('scaled-up')
  })

  it('names the inverse mistake, because the two have opposite fixes', () => {
    const landed = { x: 200 / 1.5, y: 100 / 1.5 }

    expect(scalingSignature(target, landed, 1.5)).toBe('scaled-down')
  })

  /**
   * A hit is never a scaling failure. At a ratio of 2 a target at (200,100) and a
   * click at (200,100) is simply correct, and reporting a signature would tell a
   * citizen that did the right thing to go and change it.
   */
  it('finds nothing when the click hit', () => {
    expect(scalingSignature(target, { x: 200, y: 100 }, 2)).toBeNull()
    expect(scalingSignature(target, { x: 205, y: 104 }, 2)).toBeNull()
  })

  /**
   * **A miss with no signature stays a bare miss.** Inventing a cause is worse than
   * reporting none, because the citizen goes and fixes something that was not wrong.
   */
  it('finds nothing in a miss that carries no scaling pattern', () => {
    expect(scalingSignature(target, { x: 40, y: 260 }, 1.5)).toBeNull()
  })

  it('finds nothing at a ratio of one, where the two spaces coincide', () => {
    // Numerically this is the `scaled-up` case with the factor removed, so it is the
    // test that stops the check reporting a signature for every ordinary miss on an
    // unscaled display.
    expect(scalingSignature(target, { x: 300, y: 150 }, 1)).toBeNull()
  })

  it('measures distance the way the tolerance is stated', () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })
})

describe('the page that hosts the measurements', () => {
  const page = () =>
    readFileSync(
      new URL('../../../../apps/api/public/interaction/index.html', import.meta.url),
      'utf8',
    )

  /**
   * **The gate has to be a real `input` event.** Setting `.value` from a script fires
   * none, which is precisely what makes a DOM-only fill unable to finish the form —
   * the discrimination `#163` asks for. Verified against Chromium as well: a scripted
   * `.value` assignment left the second field absent, and a real fill created it.
   */
  it('creates the second field only from an input event', () => {
    expect(page()).toMatch(/first\.addEventListener\('input'/)
    expect(page()).toContain("createElement('input')")
  })

  /**
   * `#163` forbids measuring timing, mouse path, jitter or human-likeness anywhere in
   * this stage. The API's recorded shape is pinned by a route test; this pins the page,
   * because a listener added here would be the obvious way to reintroduce it.
   */
  it('listens for nothing about how a pointer moved', () => {
    const text = page()

    for (const forbidden of [
      'mousemove',
      'pointermove',
      'mouseover',
      'performance.now',
      'Date.now',
    ]) {
      expect(text).not.toContain(forbidden)
    }
  })

  /**
   * The click listener is on the document, not on the target area, and that is load
   * bearing rather than incidental: the scaling mistake usually lands the click
   * *outside* the area, and an area-scoped listener reported nothing at all — measured
   * against Chromium at devicePixelRatio 1.5, where a target at (179, 234) put the
   * wrong click at (268, 351), past the 320 px edge.
   */
  it('reports a click that lands outside the target area', () => {
    expect(page()).toMatch(/document\.addEventListener\('click'/)
  })

  it('loads nothing from another origin', () => {
    expect(page()).not.toMatch(/(src|href)\s*=\s*["']https?:\/\//)
  })
})
