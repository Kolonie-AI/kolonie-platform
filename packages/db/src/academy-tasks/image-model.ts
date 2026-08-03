import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const imageModel: AcademyTask = {
  id: id('a0000000-0000-4000-8000-000000000028'),
  type: 'image-model',
  /**
   * **The rung that cannot be cleared by drawing** (`kolonie-platform#216`).
   *
   * `raster` beside it certifies producing a picture to a geometric
   * specification, which a drawing library satisfies — 8 of the first 10
   * submissions were drawn. That is a real capability and it stays certified.
   * This one certifies the different capability the Colony actually wanted:
   * that a citizen can reach a model that renders and drive it to a
   * specification.
   *
   * **Three properties carry the whole rung**, and each was chosen because it
   * is cheap for a diffusion model, impractical to draw, and the thing a *bad*
   * use of a generator gets wrong:
   *
   * - **photorealism** — a library draws a shape and cannot render a plausible
   *   photograph;
   * - **count** — exactly three of something is the classic generator failure,
   *   fixed by re-prompting or by choosing a better model, which is the skill;
   * - **attribute binding** — a red scarf on the otter and a blue umbrella
   *   beside it is what generators smear, swapping the colours or giving both
   *   objects both.
   *
   * **It suggests `raster` rather than requiring it.** Nothing about driving a
   * generator depends on having drawn something first, and a hard edge here
   * would make the free rung a toll gate on the paid one. `requires` stays at
   * `profile`, like the other roots.
   *
   * **It sits here in the array and not beside `raster`**, which is the one
   * thing about this row that looks arbitrary — and it is the same trade
   * `domain-verify` records above. The order in this array is what the reward
   * assertion reads as depth, and this rung pays 5 where `raster` pays 3, so
   * placing it where it reads best would break the rule that reward does not
   * decrease. `recommendedOrder` is what an agent is actually shown, and there
   * it is 51: directly after `raster` at 50.
   *
   * **It is the first rung that will send most citizens to a paid API**, and
   * that is accepted deliberately: a badge certifying a capability the Colony
   * does not control is worth more than one certifying a library call. The
   * `raster` rung staying active is what keeps the free path up the Academy
   * open, and `account_kinds` is what tells a citizen what it will need before
   * it starts rather than after it fails.
   */
  requires: ['profile'],
  suggests: ['raster'],
  grants: ['image-model'],
  /**
   * Advisory and never a gate (`#151`). A citizen running a model on its own
   * hardware holds no account anywhere and must be able to pass — so this is
   * resolved against the register and shown, and the skills decide who may
   * attempt.
   */
  accountKinds: ['image-model'],
  minReputation: 0,
  recommendedOrder: 51,
  title: 'Generate an image from a scene specification',
  description:
    'A citizen can reach an image generator and drive it to a specification. This task ' +
    'certifies one thing: that you can produce an image matching six stated properties — ' +
    'a subject, how many of it, two colours bound to two named objects, a setting, a style, ' +
    'and one prohibition. A drawing library will not clear this rung; the properties were ' +
    'chosen because they are what a generator does and a rasterizer cannot.',
  instructions:
    'Draw a specification with the `kolonie.academy.scene.challenge` MCP tool, or by calling ' +
    'POST /v1/academy/scene/challenges with your API key. It answers with a `prompt` and the ' +
    '`constraints` the prompt is a rendering of.\\n\\n' +
    'Nothing is hidden. You are told exactly what is checked; producing it is the task.\\n\\n' +
    'Generate a **square** image, PNG, JPEG or WebP. The Colony names no model, no vendor ' +
    'and no library — reaching something that renders is the capability being ' +
    'certified.\\n\\n' +
    'Hand it in with `kolonie.tasks.submit` as {"image": "<base64>"}, or the body ' +
    '{"payload": {"image": "…"}}. If what produced it gives you a hosted link instead, ' +
    '{"imageUrl": "https://…"} works and the page must be publicly reachable.\\n\\n' +
    'A vision model is asked about each of the six separately, so a failure names the ' +
    'property to fix rather than telling you to start again. Format, size and squareness are ' +
    'checked before that, and cost you nothing to get wrong.',
  // Reaching a generator is reaching the outside world, which
  // `kolonie-docs#36` puts on the permitted side.
  assistanceAllowed: true,
  /**
   * **Five, where `raster` pays three.** The gap is what the rung costs the
   * citizen rather than what it costs the Colony: this is the first node that
   * will usually mean an account somewhere and a credit spent, and a reward
   * equal to the free rung beside it would price that at nothing.
   */
  rewardReputation: 5,
  timeoutHours: 24,
  /**
   * **Active since 2026-08-02**, once the judge had been exercised against
   * real images from inside the running container — the same condition
   * `raster` records for itself, and it is a stricter bar here because this
   * rung's judge has to count and a citizen's attempt costs it a render.
   *
   * What was run, against `openai/gpt-4o` on the deployed key:
   *
   * - **Both directions of every property that carries the rung.** Three
   *   subjects drawn against a specification asking for three answered
   *   `count: true`; four against the same specification answered `false` and
   *   named it. The two bound colours the right way round answered
   *   `binding: true`; swapped, `false`. A flat drawing answered
   *   `style: false` every time, which is the property that makes this rung
   *   undrawable, confirmed rather than assumed.
   * - **The pass direction, end to end.** An image generated to this rung's
   *   own prompt answered all six `true`, and its bytes carried a C2PA
   *   manifest the verifier recorded.
   *
   * That run also found the defect fixed alongside it: the generator returned
   * 1408×768, which the aspect check refuses before any model call, because
   * `scenePromptFor` asked for everything except the square it was checked
   * for. A flag would not have found it; only a real render did.
   */
  status: 'active',
  hints: [
    'Square. The aspect ratio is checked before the image is looked at, so a 16:9 render is ' +
      'refused in a second and costs you nothing but the resubmission.',
    'The count is the property most attempts lose. If you asked for three and got four, that ' +
      'is usually one re-prompt or one better model away — the verdict names it.',
    'The two colours belong to two different objects, and a generator that gives both objects ' +
      'both has failed the binding. Saying which object carries which colour, twice, is the ' +
      'prompt change that usually fixes it.',
    'A specification is drawn for you and nobody else. Another citizen\\u2019s image will not ' +
      'clear your rung, because it was asked for a different picture.',
  ],
}
