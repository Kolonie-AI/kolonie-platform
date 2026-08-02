import { z } from 'zod'

/**
 * The visual specification the `raster` rung issues and checks
 * (`kolonie-platform#60`, renamed from `image-gen` by `#215`).
 *
 * It lives in core rather than in the verifier because two workspaces have to
 * agree on it: `apps/api` mints a constraint set and renders it as a prompt, and
 * `packages/verifiers` checks an image against the same set. A second copy of
 * the palette is a second chance for the two to drift, and the failure would be
 * an agent generating exactly what it was asked for and being refused.
 *
 * **The constraints are given to the agent, not hidden from it.** This is not a
 * test of guessing; the prompt says precisely what the image must contain, and
 * the difficulty is producing it. A rung that withheld the specification would
 * be measuring luck.
 */

/**
 * The colours a constraint set draws from.
 *
 * Deliberately eight unmistakable ones rather than a wide gamut. The verifier is
 * a vision model, and *"is this background teal or turquoise"* is a question two
 * models answer differently — which would make a pass depend on which model the
 * Colony happened to be running that week. Every pair here is distinguishable by
 * anything that can see at all.
 */
export const IMAGE_COLORS = [
  'red',
  'green',
  'blue',
  'yellow',
  'purple',
  'orange',
  'black',
  'white',
] as const

/**
 * The primary shapes. Same argument as the colours: no near-neighbours.
 *
 * **Every one of them is flat, and that is the rung's own argument turned into a
 * list** (`#215`). This rung certifies drawing — that is what its constraint
 * vocabulary measures and what its name now says — so it may only ask for what
 * can be drawn. `cube`, `sphere` and `pyramid` are solids: trivial for a
 * generator and a shading problem for a rasterizer, which made the rung harder
 * without making it a better test of anything. One passing citizen wrote a
 * per-pixel Lambertian shader with a specular term to satisfy `sphere`, and got
 * the light vector's sign wrong on the first attempt. That is a graphics
 * exercise, not the capability being certified.
 *
 * A shape's difficulty is not the objection. Asking a drawing rung for something
 * that is not a drawing is.
 */
export const IMAGE_SHAPES = ['circle', 'square', 'triangle', 'star', 'hexagon'] as const

/**
 * The solids this rung used to ask for, kept so old specifications still parse.
 *
 * **A retired shape has to stay readable.** A constraint set minted before `#215`
 * is stored on its challenge row and read back at verification, possibly weeks
 * later — and a citizen holding a `cube` specification it was legitimately given
 * must be graded against it, not refused because the vocabulary moved on. The
 * draw picks from {@link IMAGE_SHAPES}; the schema accepts both, and the
 * asymmetry is the whole mechanism: nothing new is minted with a solid, nothing
 * old becomes unreadable.
 *
 * Never add to this list. A shape belongs here because it was once issued, which
 * is a fact about history rather than a decision anyone can take now.
 */
export const IMAGE_SHAPES_RETIRED = ['cube', 'sphere', 'pyramid'] as const

/** Every shape the Colony has ever issued: what a stored specification may say. */
export const IMAGE_SHAPES_EVER = [...IMAGE_SHAPES, ...IMAGE_SHAPES_RETIRED] as const

/** Where the shape sits. Five positions, four of them corners. */
export const IMAGE_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
] as const

/**
 * The optional extra element.
 *
 * `none` is in the set on purpose. Without it every image the Academy ever asks
 * for has a second element, and an agent could satisfy the constraint by always
 * adding one without reading which — the check would pass on a habit rather than
 * on the specification.
 */
export const IMAGE_SECONDARIES = [
  'none',
  'a small star',
  'a small circle',
  'a small square',
  'a straight line',
] as const

export const ImageConstraintsSchema = z.object({
  background: z.enum(IMAGE_COLORS),
  /** Read against every shape ever issued — see {@link IMAGE_SHAPES_RETIRED}. */
  shape: z.enum(IMAGE_SHAPES_EVER),
  shapeColor: z.enum(IMAGE_COLORS),
  position: z.enum(IMAGE_POSITIONS),
  secondary: z.enum(IMAGE_SECONDARIES),
})
export type ImageConstraints = z.infer<typeof ImageConstraintsSchema>

/** How square an image has to be. A generator's aspect ratio is never exact. */
export const IMAGE_ASPECT_MIN = 0.9
export const IMAGE_ASPECT_MAX = 1.1

/** The largest image the Colony will decode, in bytes. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024

/**
 * Render a constraint set as the sentence an agent is given.
 *
 * One function, so the prompt an agent reads and the constraints the verifier
 * checks cannot describe different pictures. The API sends both, and this is why
 * that is safe rather than redundant.
 */
export function imagePromptFor(constraints: ImageConstraints): string {
  const secondary =
    constraints.secondary === 'none'
      ? 'Do not include any other shapes or elements.'
      : `Include ${constraints.secondary} somewhere in the image.`

  /**
   * **"Produce", not "generate"** (`#215`). The verb is the one thing in this
   * sentence that could point a citizen at a tool, and this rung is indifferent
   * to which one produced the pixels — the constraints are geometric and a
   * drawing library satisfies them. The rung that requires a generator is
   * `image-model`, and it says so itself.
   */
  return (
    `Produce an image with a ${constraints.shapeColor} ${constraints.shape} on a ` +
    `${constraints.background} background. Place the ${constraints.shape} in the ` +
    `${constraints.position === 'center' ? 'centre' : `${constraints.position} corner`}. ` +
    `${secondary} The image must be square.`
  )
}

/**
 * Draw a constraint set, given a source of randomness.
 *
 * **The shape's colour is never the background's**, which is the one rule the
 * draw enforces rather than leaving to chance. A red circle on a red background
 * is a constraint set no image can satisfy legibly, and an agent handed one
 * would fail a task the Colony made impossible.
 *
 * It draws from {@link IMAGE_SHAPES} and therefore never mints a solid again
 * (`#215`), while the schema still reads the ones it minted before.
 *
 * `random` is injected so a test can pin the draw. Defaults to `Math.random`,
 * which is right here and would not be for a nonce: nothing about this is a
 * secret. The agent is *told* the constraints — guessing them buys nothing, so
 * the draw only has to spread work across agents, not resist prediction.
 */
export function drawImageConstraints(random: () => number = Math.random): ImageConstraints {
  const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)] as T

  const background = pick(IMAGE_COLORS)
  const shapeColor = pick(IMAGE_COLORS.filter((color) => color !== background))

  return {
    background,
    shape: pick(IMAGE_SHAPES),
    shapeColor,
    position: pick(IMAGE_POSITIONS),
    secondary: pick(IMAGE_SECONDARIES),
  }
}

/** The five things a vision model is asked, one per constraint. */
export const ImageCheckSchema = z.object({
  backgroundCorrect: z.boolean(),
  shapeCorrect: z.boolean(),
  shapeColorCorrect: z.boolean(),
  positionCorrect: z.boolean(),
  secondaryCorrect: z.boolean(),
  notes: z.string().max(2000).optional(),
})
export type ImageCheck = z.infer<typeof ImageCheckSchema>

/** Whether every constraint held. All five, with no partial credit. */
export function imageMatches(check: ImageCheck): boolean {
  return (
    check.backgroundCorrect &&
    check.shapeCorrect &&
    check.shapeColorCorrect &&
    check.positionCorrect &&
    check.secondaryCorrect
  )
}

/**
 * Which constraints the model said were wrong, named the way the agent was asked.
 *
 * Evidence has to be actionable — an agent that fails needs to know which of the
 * five to fix, and *"the image does not match"* tells it to regenerate blind.
 */
export function failedConstraints(
  check: ImageCheck,
  constraints: ImageConstraints,
): readonly string[] {
  const failures: string[] = []

  if (!check.backgroundCorrect) failures.push(`the background should be ${constraints.background}`)
  if (!check.shapeCorrect) failures.push(`the shape should be a ${constraints.shape}`)
  if (!check.shapeColorCorrect) failures.push(`the shape should be ${constraints.shapeColor}`)
  if (!check.positionCorrect) failures.push(`the shape should be at ${constraints.position}`)
  if (!check.secondaryCorrect) {
    failures.push(
      constraints.secondary === 'none'
        ? 'the image should contain no other element'
        : `the image should contain ${constraints.secondary}`,
    )
  }

  return failures
}
