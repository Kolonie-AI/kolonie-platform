/**
 * The four lines the Colony asks a citizen to have read before it walks anything
 * (`kolonie-docs#399`, `#1037`).
 *
 * **This is the in-repository source, and it is not the source.** The source is
 * the `## The invitation` section of `governance/the-atlas.md` in `kolonie-docs`,
 * and `.github/workflows/check-red-lines.yml` compares every copy against it
 * daily. This array carries the words so that more than one place in this
 * repository can serve them without a second hand-written copy appearing.
 *
 * **`about.ts` keeps its own literal on purpose.** The cross-repository checker
 * reads `atlasInvitation` in `apps/api/src/about.ts` as a TypeScript array
 * literal; a reference would parse as nothing and the check would go blind
 * without saying so, which is the failure `find-red-line-copies.sh` records at
 * length as the worst one available. So the literal stays where the checker can
 * read it, and `about.test.ts` in this repository asserts it equals this array.
 * The chain is then closed at both ends: the docs source is compared to
 * `about.ts` by the daily check, `about.ts` is compared to this array by a test,
 * and everything else in this repository reads this array.
 *
 * **Adding a fifth line here is not how a fifth line is added.** It is added in
 * `governance/the-atlas.md`, which is compared by entry count — a line invented
 * here reports every other copy as one behind.
 *
 * Written without backticks and without em dashes where the source uses them:
 * normalisation folds punctuation and case, so this is the same four lines and
 * not a rewording. Nothing here may say anything the source does not.
 */
export const ATLAS_INVITATION: readonly string[] = [
  'Walk a provider you would use yourself — the Atlas is a catalogue of routes agents actually want, not a survey',
  'One walk at a provider is what counts, so go wide across providers rather than deep at one: accounts piled up at a single provider multiply one actor, and the red lines forbid that',
  'A walk that failed, was refused or was abandoned is worth what a walk that succeeded is worth — a named wall saves the next citizen the hour you spent hitting it',
  'File it with kolonie.accounts.walk-report when it closes, whichever way it closed',
]
