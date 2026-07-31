import { describe, expect, it } from 'vitest'
import {
  drawImageConstraints,
  failedConstraints,
  imageMatches,
  imagePromptFor,
  ImageConstraintsSchema,
  IMAGE_COLORS,
  type ImageCheck,
  type ImageConstraints,
} from './image-constraints.js'

const allTrue: ImageCheck = {
  backgroundCorrect: true,
  shapeCorrect: true,
  shapeColorCorrect: true,
  positionCorrect: true,
  secondaryCorrect: true,
}

const CONSTRAINTS: ImageConstraints = {
  background: 'green',
  shape: 'cube',
  shapeColor: 'red',
  position: 'top-left',
  secondary: 'a small star',
}

describe('drawImageConstraints', () => {
  /**
   * A red cube on a red background is not a hard specification, it is an
   * impossible one, and every honest attempt at it would be refused by a vision
   * model that was right.
   */
  it('never draws a shape the colour of its own background', () => {
    // Every value the draw can take, forced one at a time. A property this
    // important is not left to a handful of random samples.
    for (let step = 0; step < 200; step += 1) {
      const constraints = drawImageConstraints(() => (step % 100) / 100)

      expect(constraints.shapeColor).not.toBe(constraints.background)
    }
  })

  it('draws only values the schema accepts', () => {
    for (let step = 0; step < 200; step += 1) {
      expect(ImageConstraintsSchema.safeParse(drawImageConstraints()).success).toBe(true)
    }
  })

  it('can reach every colour as a background', () => {
    const seen = new Set<string>()
    for (let step = 0; step < 500; step += 1) seen.add(drawImageConstraints().background)

    expect(seen.size).toBe(IMAGE_COLORS.length)
  })
})

describe('imagePromptFor', () => {
  it('names every constraint, so the sentence and the check agree', () => {
    const prompt = imagePromptFor(CONSTRAINTS)

    expect(prompt).toContain('red')
    expect(prompt).toContain('cube')
    expect(prompt).toContain('green')
    expect(prompt).toContain('top-left')
    expect(prompt).toContain('a small star')
    expect(prompt).toContain('square')
  })

  /**
   * `none` has to read as an instruction, not as an omission. A prompt that
   * simply said nothing would let an agent add a decoration and fail a
   * constraint it was never told about.
   */
  it('turns an absent secondary element into an explicit prohibition', () => {
    const prompt = imagePromptFor({ ...CONSTRAINTS, secondary: 'none' })

    expect(prompt).toContain('Do not include any other shapes')
  })

  it('says "centre" rather than "center corner"', () => {
    expect(imagePromptFor({ ...CONSTRAINTS, position: 'center' })).not.toContain('center corner')
  })
})

describe('imageMatches', () => {
  it('needs all five, with no partial credit', () => {
    expect(imageMatches(allTrue)).toBe(true)

    for (const key of Object.keys(allTrue) as (keyof ImageCheck)[]) {
      expect(imageMatches({ ...allTrue, [key]: false }), `${key} alone should sink it`).toBe(false)
    }
  })
})

describe('failedConstraints', () => {
  it('names only what failed, in the terms the agent was asked in', () => {
    const failures = failedConstraints(
      { ...allTrue, shapeColorCorrect: false, positionCorrect: false },
      CONSTRAINTS,
    )

    expect(failures).toEqual(['the shape should be red', 'the shape should be at top-left'])
  })

  it('says nothing when nothing failed', () => {
    expect(failedConstraints(allTrue, CONSTRAINTS)).toEqual([])
  })
})
