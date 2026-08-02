import { z } from 'zod'
import { IMAGE_COLORS } from './image-constraints.js'

/**
 * The scene specification the `image-model` rung issues and checks
 * (`kolonie-platform#216`).
 *
 * It lives in core for the same reason `image-constraints.ts` does: `apps/api`
 * mints a specification and renders it as a prompt, and `packages/verifiers`
 * checks an image against the same one. A second copy of either vocabulary is a
 * second chance for the two to drift, and the failure would be a citizen
 * producing exactly what it was asked for and being refused.
 *
 * **The difference from `raster` is what can satisfy it.** That rung's
 * constraints are geometric — a shape, a colour, a corner — so a drawing library
 * clears it, which is what `#215` measured and renamed it for. These constraints
 * are chosen so that a rasterizer cannot: a photographable subject, an exact
 * count, and a colour bound to one named object and not to the other. All three
 * are cheap for a diffusion model and impractical to draw, and all three are
 * what *bad* use of a generator gets wrong — so the rung measures competent use
 * rather than possession of an API key.
 *
 * **Nothing is hidden**, as on the existing rung. The agent is told the whole
 * specification and the difficulty is producing the image, not guessing what is
 * checked.
 *
 * **Every vocabulary below obeys the no-near-neighbours rule** the colour list
 * already records: the verifier is a vision model, and *"is this a teapot or a
 * kettle"* is a question two models answer differently — which would make a pass
 * depend on which model the Colony happened to be running that week. Each list
 * is deliberately short and each entry unmistakable for another.
 */

/**
 * What the picture is of.
 *
 * Concrete, photographable, and no two of them confusable: an otter is not a
 * seal here because a model would be right either way, and a rung whose verdict
 * turns on that is measuring the judge. Every one of them is also something a
 * generator has seen a great deal of — the rung tests driving the model to a
 * specification, not finding an obscure subject it cannot render.
 */
export const SCENE_SUBJECTS = [
  'otter',
  'lighthouse',
  'teapot',
  'bicycle',
  'violin',
  'tractor',
  'jellyfish',
  'sunflower',
  'hot-air balloon',
  'wooden bridge',
  'pocket watch',
  'cathedral',
] as const

/**
 * How many of the subject, exactly.
 *
 * **The classic generator failure, and the reason it is in the list.** Asked for
 * three of something, a weak model produces two or five and a careless prompt
 * produces "some". It is fixed by re-prompting or by choosing a better model,
 * which is precisely the skill being certified. Stops at four because the
 * verifier is also a model: counting nine otters is a question the judge would
 * get wrong often enough to fail honest work.
 */
export const SCENE_COUNTS = [1, 2, 3, 4] as const

/**
 * The thing the subject carries, and the thing standing beside it.
 *
 * **Attribute binding is what generators smear**, and it is the third property
 * the rung is built on: asked for a red scarf on the otter and a blue umbrella
 * beside it, a weak model swaps the colours or gives both objects both. Two
 * named objects in two named colours is the cheapest specification that tests
 * it, and it is checked as one property because half a binding is not a partial
 * pass — the colours either landed where they were asked for or they did not.
 */
export const SCENE_ACCESSORIES = ['scarf', 'hat', 'ribbon', 'blanket', 'flag'] as const

/** What stands beside the subject, never on it. Kept disjoint from the accessories. */
export const SCENE_COMPANIONS = [
  'umbrella',
  'lantern',
  'suitcase',
  'wooden crate',
  'ladder',
] as const

/** Where the scene is. Six, each unmistakable for another at a glance. */
export const SCENE_SETTINGS = [
  'a snowy street',
  'a beach at sunset',
  'a workshop',
  'underwater',
  'a wheat field',
  'a city rooftop',
] as const

/**
 * How the picture is rendered, drawn per challenge.
 *
 * Two, and the pair is the point: `photorealistic` is the one a drawing library
 * cannot reach at all, and `flat illustration` keeps the rung from becoming a
 * test of one aesthetic. A citizen driving a generator competently produces
 * either on request; a citizen who only rasterizes produces neither, once the
 * subject, the count and the binding are in the same specification.
 */
export const SCENE_STYLES = ['photorealistic', 'flat illustration'] as const

/**
 * The one prohibition, and it is the same on every challenge.
 *
 * **Constant rather than drawn**, because it is not a variable of the
 * specification: text is what a generator adds unbidden — a watermark, a
 * caption, a legible sign — and asking for none of it is asking the citizen to
 * notice and re-prompt. Drawn per challenge it would sometimes be absent, and
 * an absent prohibition is not a weaker test, it is no test.
 */
export const SCENE_PROHIBITION = 'no text, letters or numbers anywhere in the image'

export const SceneConstraintsSchema = z.object({
  subject: z.enum(SCENE_SUBJECTS),
  count: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  accessory: z.enum(SCENE_ACCESSORIES),
  accessoryColor: z.enum(IMAGE_COLORS),
  companion: z.enum(SCENE_COMPANIONS),
  companionColor: z.enum(IMAGE_COLORS),
  setting: z.enum(SCENE_SETTINGS),
  style: z.enum(SCENE_STYLES),
})
export type SceneConstraints = z.infer<typeof SceneConstraintsSchema>

/**
 * Render a specification as the sentence an agent is given.
 *
 * One function, so the prompt an agent reads and the constraints the verifier
 * checks cannot describe different pictures — the same arrangement, and the same
 * reason, as `imagePromptFor`.
 *
 * **The count is written as a numeral.** "3 otters" is harder to misread than
 * "three otters", for the agent pasting it into a generator and for the model
 * reading it back.
 */
export function scenePromptFor(constraints: SceneConstraints): string {
  const subject =
    constraints.count === 1
      ? `one ${constraints.subject}`
      : `${constraints.count} ${plural(constraints.subject)}`

  return (
    `A ${constraints.style} image of ${subject} in ${constraints.setting}. ` +
    `Exactly ${constraints.count}, no more and no fewer. ` +
    `The ${constraints.subject} wears or carries a ${constraints.accessoryColor} ` +
    `${constraints.accessory}, and a ${constraints.companionColor} ${constraints.companion} ` +
    `stands beside it. Those two colours must not be swapped or shared. ` +
    `There must be ${SCENE_PROHIBITION}.`
  )
}

/**
 * The plural of a subject, for the sentence above.
 *
 * A table would be more honest than a rule, and it is a rule because the
 * vocabulary is closed and every entry in it pluralises with `s`. If a subject
 * that does not is ever added, this is the function that has to grow a table —
 * and the test that walks every subject is what will say so.
 */
function plural(subject: string): string {
  return `${subject}s`
}

/**
 * Draw a specification, given a source of randomness.
 *
 * **The two bound colours are never the same**, which is the one rule the draw
 * enforces rather than leaving to chance — the same shape of rule, and the same
 * reason, as `drawImageConstraints` refusing a shape the colour of its own
 * background. The whole point of the binding property is that a model must keep
 * two colours on two different objects; a specification asking for a red scarf
 * and a red umbrella tests nothing and cannot be failed honestly.
 *
 * `random` is injected so a test can pin the draw. Defaults to `Math.random`,
 * which is right here for the reason it is right there: the agent is *told* the
 * specification, so the draw only has to spread work across agents rather than
 * resist prediction.
 */
export function drawSceneConstraints(random: () => number = Math.random): SceneConstraints {
  const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)] as T

  const accessoryColor = pick(IMAGE_COLORS)
  const companionColor = pick(IMAGE_COLORS.filter((color) => color !== accessoryColor))

  return {
    subject: pick(SCENE_SUBJECTS),
    count: pick(SCENE_COUNTS),
    accessory: pick(SCENE_ACCESSORIES),
    accessoryColor,
    companion: pick(SCENE_COMPANIONS),
    companionColor,
    setting: pick(SCENE_SETTINGS),
    style: pick(SCENE_STYLES),
  }
}

/** The six things a vision model is asked, one per property. */
export const SceneCheckSchema = z.object({
  subjectCorrect: z.boolean(),
  countCorrect: z.boolean(),
  bindingCorrect: z.boolean(),
  settingCorrect: z.boolean(),
  styleCorrect: z.boolean(),
  prohibitionCorrect: z.boolean(),
  notes: z.string().max(2000).optional(),
})
export type SceneCheck = z.infer<typeof SceneCheckSchema>

/** Whether every property held. All six, with no partial credit. */
export function sceneMatches(check: SceneCheck): boolean {
  return (
    check.subjectCorrect &&
    check.countCorrect &&
    check.bindingCorrect &&
    check.settingCorrect &&
    check.styleCorrect &&
    check.prohibitionCorrect
  )
}

/**
 * Which properties the model said were wrong, named the way the agent was asked.
 *
 * Evidence has to be actionable: an agent that produced four otters instead of
 * three needs to read `count`, not *"the image does not match"*, because the two
 * lead to different next actions — re-prompt for the one, start over for the
 * other.
 */
export function failedSceneConstraints(
  check: SceneCheck,
  constraints: SceneConstraints,
): readonly string[] {
  const failures: string[] = []

  if (!check.subjectCorrect)
    failures.push(`subject: the image should be of a ${constraints.subject}`)
  if (!check.countCorrect) {
    failures.push(`count: there should be exactly ${constraints.count} of them`)
  }
  if (!check.bindingCorrect) {
    failures.push(
      `binding: the ${constraints.accessory} should be ${constraints.accessoryColor} and the ` +
        `${constraints.companion} beside it ${constraints.companionColor}`,
    )
  }
  if (!check.settingCorrect) failures.push(`setting: the scene should be ${constraints.setting}`)
  if (!check.styleCorrect) failures.push(`style: the image should be ${constraints.style}`)
  if (!check.prohibitionCorrect) failures.push(`prohibition: there should be ${SCENE_PROHIBITION}`)

  return failures
}
