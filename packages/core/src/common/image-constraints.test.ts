import { describe, expect, it } from 'vitest'
import {
  drawImageConstraints,
  failedConstraints,
  imageMatches,
  imagePromptFor,
  ImageConstraintsSchema,
  IMAGE_COLORS,
  IMAGE_SHAPES,
  IMAGE_SHAPES_RETIRED,
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

  /**
   * The rung certifies drawing, so it may only ask for what can be drawn
   * (`#215`). A solid is a shading problem rather than a harder drawing, and one
   * reaching a citizen would be the rung asking for the wrong thing again.
   */
  it('never draws a solid', () => {
    for (let step = 0; step < 500; step += 1) {
      expect(IMAGE_SHAPES_RETIRED).not.toContain(drawImageConstraints().shape)
    }
  })

  it('can still reach every shape it does draw', () => {
    const seen = new Set<string>()
    for (let step = 0; step < 500; step += 1) seen.add(drawImageConstraints().shape)

    expect(seen.size).toBe(IMAGE_SHAPES.length)
  })

  it('can reach every colour as a background', () => {
    const seen = new Set<string>()
    for (let step = 0; step < 500; step += 1) seen.add(drawImageConstraints().background)

    expect(seen.size).toBe(IMAGE_COLORS.length)
  })
})

describe('ImageConstraintsSchema', () => {
  /**
   * The rejection case `#215` names, and it is a rejection that must **not**
   * happen. A specification naming a solid was legitimately issued before the
   * rename, sits on a challenge row, and is read back at verification — possibly
   * long afterwards. Refusing it as unknown would fail a citizen for holding
   * exactly what the Colony gave it.
   *
   * This is why the fixture above still says `cube`: the whole suite is
   * exercised against a retired shape, so nothing can quietly start assuming the
   * five current ones are all that ever existed.
   */
  it('still reads a specification minted before the solids were retired', () => {
    for (const shape of IMAGE_SHAPES_RETIRED) {
      const stored = ImageConstraintsSchema.safeParse({ ...CONSTRAINTS, shape })

      expect(stored.success, `${shape} was issued once and must stay readable`).toBe(true)
    }
  })

  it('refuses a shape the Colony has never issued', () => {
    expect(
      ImageConstraintsSchema.safeParse({ ...CONSTRAINTS, shape: 'dodecahedron' }).success,
    ).toBe(false)
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
