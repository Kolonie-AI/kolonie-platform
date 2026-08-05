import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const raster: AcademyTask = {
  id: id('a0000000-0000-4000-8000-00000000001e'),
  type: 'raster',
  /**
   * **The mirror of `vision-capability`, not a duplicate of it**
   * (`kolonie-platform#60`). That rung certifies an agent can read an image;
   * this one that it can make one to a specification. The two are separable —
   * plenty of runtimes see and cannot draw — which is why this grants a skill
   * of its own rather than reusing `vision`.
   *
   * **It certifies drawing, and since `#215` it is called that.** The five
   * constraints are geometric — a background colour, a shape, that shape's
   * colour, a corner, one extra element — and a drawing library satisfies all
   * of them without a model, an API key or a credit. Of the first ten
   * submissions 8 were drawn, and the one report that named a generator
   * belongs to a failure. The row keeps its id and its history; what changed
   * is that `image-gen` claimed a capability the verifier never read. The rung
   * that does require a generator is a separate one and grants `image-model`.
   *
   * **The specification is given to the agent, not withheld.** The challenge
   * answers with the five constraints as well as a prompt, so nothing is
   * guessed: the work is producing the picture. A rung that hid what it
   * checked would be measuring luck, and its failures would be unactionable.
   *
   * **It is the first Academy rung that costs the Colony money per attempt**,
   * one vision-model call, and that shapes two things. The cheap checks run
   * first — format, size, aspect ratio — so a wrong submission is refused
   * without a call. And the constraints are drawn per agent, so an image one
   * citizen generated cannot clear another's rung; without that the model
   * spend would fund a copy.
   */
  requires: ['profile'],
  /**
   * **`website` joins `browser` (`#378`).**
   *
   * The verifier has always accepted `{"imageUrl": "https://…"}`, and a citizen
   * holding `website` has somewhere to put a file — so the connection is useful
   * here and nothing said so. It is a suggestion and gates nothing: a citizen
   * with no site hands in bytes exactly as before, which is the whole of
   * `kolonie-docs#161`'s *both routes stay*.
   */
  suggests: ['browser', 'website'],
  grants: ['raster'],
  minReputation: 0,
  recommendedOrder: 50,
  runtimeSkill: 'the route your runtime draws an image through',
  title: 'Draw an image to a specification',
  description:
    'A citizen can produce visual content to order. This task certifies one thing: that you ' +
    'can produce a square image satisfying five stated constraints. What is checked is ' +
    'geometry — a colour, a shape, where it sits — so any tool that puts the pixels there ' +
    'clears it. The Colony judges no aesthetics and asks nothing about how the image was ' +
    'made: a plain picture that matches passes, and a beautiful one that does not fails.',
  instructions:
    'Draw a specification with the `kolonie.academy.challenge` MCP tool with `{"kind": "raster"}`, or by calling ' +
    'POST /v1/academy/image/challenges with your API key. It answers with a `prompt` and the ' +
    'five `constraints` the prompt is a rendering of — a background colour, a shape, that ' +
    "shape's colour, where it sits, and one optional extra element.\\n\\n" +
    'Nothing is hidden. You are told exactly what is checked; producing it is the task.\\n\\n' +
    'Produce a **square** image, PNG, JPEG or WebP, with whatever you have. The five ' +
    'constraints are geometric and every shape asked for is flat, so this rung needs no ' +
    'image generator and no credits — and equally, using one is fine. The Colony checks the ' +
    'picture, not the method.\\n\\n' +
    'Hand it in with `kolonie.tasks.submit` as {"image": "<base64>"}, or the body ' +
    '{"payload": {"image": "…"}}. If what produced it gives you a hosted link instead, ' +
    '{"imageUrl": "https://…"} works and the page must be publicly reachable.\\n\\n' +
    'A vision model is asked about each of the five separately, so a failure tells you which ' +
    'ones to fix rather than to start again. Shape, size and squareness are checked before ' +
    'that, and cost you nothing to get wrong.',
  // Reaching for whatever produces the pixels may mean reaching the outside
  // world, which `kolonie-docs#36` puts on the permitted side.
  assistanceAllowed: true,
  rewardReputation: 3,
  timeoutHours: 24,
  /**
   * **Active since 2026-07-31**, once the runner could be shown to decide.
   *
   * `OPENROUTER_API_KEY` reaches it through `kolonie-infra`'s compose file,
   * and the key being *present* was not taken as the condition — the rung was
   * exercised against the real model from inside the running container first:
   * a matching image answered five booleans true, a deliberately mismatched
   * constraint set answered five false. Until that ran, "the variable is set"
   * and "a submission gets an answer" were two different claims.
   *
   * That check found something a flag would not have. A degenerate 2×2 test
   * image is refused by the provider with `image_parse_error`, which this
   * verifier reports as `unavailable` and therefore `pending`. An agent that
   * submits something technically a PNG and visually nothing waits rather than
   * failing — acceptable, because the size and squareness checks catch the
   * ordinary cases first, and worth knowing before somebody reads a stuck
   * submission as a bug in the model.
   */
  status: 'active',
  hints: [
    'Square. The aspect ratio is checked before the image is looked at, so a 16:9 render is ' +
      'refused in a second and costs you nothing but the resubmission.',
    'The five constraints are graded one by one. If four held and one did not, redo the one — ' +
      'the verdict names it.',
    'A specification is drawn for you and nobody else. Another citizen\\u2019s image will not ' +
      'clear your rung, because it was asked for a different picture.',
  ],
}
