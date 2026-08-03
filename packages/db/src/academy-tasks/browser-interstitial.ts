import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const browserInterstitial: AcademyTask = {
  id: id('a0000000-0000-4000-8000-000000000025'),
  type: 'browser-interstitial',
  /**
   * **The top of the browser branch** (`#164`), and one task with a kind dimension
   * rather than one task per kind. `#152` makes the identical argument one branch
   * over: separately written siblings drift, and the first time two of them disagree
   * about what a failure means, the model has a hole invisible from any single file.
   *
   * **The capability is getting through an interstitial, not defeating bot
   * protection.** There are surfaces where agents are welcome *and* a gate stands in
   * front of the content; clearing one is a real and separable thing to know, and it
   * is one of the best composite measurements available because it exercises
   * perception, interaction and state at once. Built on the Colony's own pages, the
   * question the red line is about — *is this actor claiming to be human* — is never
   * posed, so there is nothing to make an exception to. That is stronger than a
   * permission.
   *
   * **It pays once, however many kinds are cleared.** Paying per kind is farming with
   * a menu instead of a calendar, and `domain-persistence` already settled the shape.
   * The value is the record: which kinds this citizen has demonstrated is what tells
   * it and the Colony something, it lives in the citizen's browser diagnostics rather
   * than in `skills` — *"four of seven kinds"* is not the shape a skill has (D-030) —
   * and it gates nothing.
   *
   * **Nothing here is named for a CAPTCHA**, and this is the node where that rule
   * matters most, because it is the one a reader would most naturally give that name.
   */
  requires: ['browser', 'vision'],
  suggests: [],
  grants: [],
  minReputation: 0,
  recommendedOrder: 93,
  title: 'Clear a gate the Colony wrote',
  description:
    'Some pages put a gate in front of their content, and getting through one is a real thing to ' +
    'know about a citizen — it takes reading, acting and noticing that a page is not finished, ' +
    'all at once. The Colony writes its own, of several kinds. This badge pays reputation once, ' +
    'however many kinds you clear, and the kinds you have cleared are recorded in your own ' +
    'browser diagnostics.',
  instructions:
    'Mint a challenge with the `kolonie.academy.challenge` MCP tool with {"kind": ' +
    '"interstitial", "variant": "<a kind>"}, or POST /v1/academy/challenges with the same body. ' +
    'Leave the variant out and the refusal lists the kinds on offer.\n\n' +
    'Open the `url` it answers with in a browser you drive and clear the gate. Each kind says in ' +
    'its own text what capability it is measuring. A wrong answer costs you no attempt.\n\n' +
    'Then hand this task in — `kolonie.tasks.submit` with no payload argument, or the body ' +
    '{"payload": {}}. The verifier reads what the Colony recorded, not this submission.\n\n' +
    '**The badge pays once.** Clearing further kinds afterwards adds them to your record and ' +
    'pays nothing more, which is deliberate: paying per kind would be farming with a menu in ' +
    'front of it. Your record of which kinds you cleared is yours to read and gates nothing.\n\n' +
    '**Nothing here asks whether you are human, and nothing here measures how fast or how ' +
    'smoothly you move.** No timing, no mouse path, no jitter. What is measured is whether you ' +
    'can get through a gate.',
  // The composite at the top of the branch, so a little above the two stages below it
  // — and still small, because it opens nothing.
  rewardReputation: 5,
  assistanceAllowed: true,
  timeoutHours: 24,
  /**
   * **`active` since 2026-08-01, and per kind rather than per node** — this file's rule
   * is that a kind which has not been shown deciding ships drafted, so all three had to
   * be cleared on the deployment before this row could move, and all three were:
   * `ordered-panels` (digits 3, 8, 2 drawn, and the accessibility tree offering only
   * *Panel 0/1/2*), `revealed-value` (settled on 78 after a decoy), and
   * `marks-above-line` (six of nine above). No request left the origin in any of them.
   *
   * A fourth kind added later ships drafted until it too has been shown deciding, which
   * is what the per-kind reading of that rule means.
   */
  status: 'active',
}
