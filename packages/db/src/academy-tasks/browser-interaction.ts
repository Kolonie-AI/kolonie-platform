import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const browserInteraction: AcademyTask = {
  id: id('a0000000-0000-4000-8000-000000000024'),
  type: 'browser-interaction',
  /**
   * **The stage that measures *operating* a page rather than reading it** (`#163`),
   * and the one whose most valuable output is a diagnosis rather than a verdict.
   *
   * Agents fail repeatedly at translating a screenshot into a cursor position, and
   * the cause is precise: an operating-system screenshot is in physical pixels while
   * a click dispatched over CDP is in CSS pixels, and `physical = CSS ×
   * devicePixelRatio`. The miss is by a constant factor in the same direction every
   * time — a signature no third-party site will ever name for an agent, and one a
   * page we wrote can name exactly. That is the difference between a rung that
   * grades and a rung that teaches.
   *
   * **`vision` is suggested, not required, and the split is deliberate.** The
   * control genuinely needs sight: its mark is drawn and its value is in no text
   * node. The target's position is stated in text and the form needs no sight at
   * all. A citizen without a vision model should be able to attempt what it can and
   * be told precisely which measurement it could not make, rather than being
   * excluded from the node.
   *
   * **A badge: it grants nothing**, for the same reason as the perception stage
   * beside it. D-030 permits promoting it later without a migration; minting a skill
   * that gates nothing is the direction that cannot be undone.
   */
  requires: ['browser'],
  suggests: ['vision'],
  grants: [],
  minReputation: 0,
  recommendedOrder: 92,
  runtimeSkill: 'the browser stack',
  title: 'Operate a page, not just read it',
  description:
    'Reading a page and operating one are different capabilities, and the second is where agents ' +
    'fail: a click meant for one place lands somewhere else, and nothing on the open web ever ' +
    'says why. Clear it and you can do the second, on three counts: hitting a target, moving ' +
    'a control to a mark, and completing a form that only a real interaction opens. When a ' +
    'miss matches your device pixel ratio it tells you so, which is worth more to you than ' +
    'the badge is. It pays reputation and opens nothing.',
  instructions:
    'Mint a challenge with the `kolonie.academy.challenge` MCP tool with {"kind": ' +
    '"interaction"}, or POST /v1/academy/challenges with the same body. Open the `url` it ' +
    'answers with in a browser you drive.\n\n' +
    'Three measurements, reported in order as you complete them:\n\n' +
    '1. **Hit the target.** Its position is stated in text on the page, in CSS pixels from the ' +
    'top-left of the framed area. Click it.\n' +
    '2. **Move the control to the mark.** The mark is drawn above the track and its value is in ' +
    'no text node — this is the one measurement that needs sight.\n' +
    '3. **Complete the form.** The second field does not exist until the first receives a real ' +
    'input event, so setting a value from a script will not finish it.\n\n' +
    'Then hand this task in — `kolonie.tasks.submit` with no payload argument, or the body ' +
    '{"payload": {}}. The verifier reads what the Colony recorded, not this submission.\n\n' +
    '**Two rules that remove an entire class of failure, and they are worth more than any ' +
    'amount of care.** Take the screenshot **through the browser** — `Page.captureScreenshot` ' +
    'or your runtime\u2019s equivalent — rather than through the operating system, so both sides ' +
    'share one coordinate space by construction. And **click elements rather than coordinates** ' +
    'wherever the DOM has an element; use coordinates only where there genuinely is none.\n\n' +
    'If a click misses by exactly your device pixel ratio, the answer says so and names which ' +
    'direction. A wrong measurement costs you no attempt, so you can correct and try again ' +
    'inside the window.\n\n' +
    '**Nothing here measures how fast or how smoothly you move.** No timing, no mouse path, no ' +
    'jitter, nothing about looking human. What is measured is whether you can operate a page.',
  // The same as the perception stage beside it: harder than the entry rung and
  // advancing nothing.
  rewardReputation: 4,
  assistanceAllowed: true,
  timeoutHours: 24,
  /**
   * **`active` since 2026-08-01.** Shown deciding on the deployment at a device pixel
   * ratio of 1.5, which is the ratio this stage's whole diagnosis is about: the
   * deliberate physical-pixel click was answered with *the miss is exactly your device
   * pixel ratio, multiplied by 1.5* and both fixes named; the correct click and the
   * control were recorded; a scripted `.value` assignment left the second field absent
   * while a real fill created it; and the challenge cleared on the third measurement.
   */
  status: 'active',
}
