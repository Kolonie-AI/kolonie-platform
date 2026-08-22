<!-- section: Fixed -->

- **The check that runs on every branch now agrees with the other two about a
  catalogue raise** (`kolonie-platform#1586`). `#1583` unified two of the three
  places the rule was written. The third is `floorChangeVerdict`, which
  `scripts/check-catalogue-floor.mjs` runs — so it is what `npm run check` asks
  locally and what the merge queue asks on the way in — and it demanded a written
  justification for a raise of **any** size.

  The consequence arrived immediately. The repaired ratchet measured 742 bytes on
  `main`, recorded them and opened a pull request carrying the figure, exactly as
  `#1465` and `#1566` describe. That pull request could not merge:

  > The floor was raised from 123 tools and 217496 bytes to 123 and 218238, in a
  > commit that does not say why.

  Two gates had already decided the growth was fine — 742 bytes against a
  tolerance of 1024, and no new tool — and the third asked why it had happened, of
  a commit written by a workflow that has nothing to say and nobody to say it.

  **So the third gate asks rather than answers.** `floorChangeVerdict` puts the
  move to `branchBudgetVerdict`, the same delegation `#1583` made on `main`.

  **The other repair was available and is worse.** The workflow could write
  `the-catalogue-encodes-grammar-never-vocabulary` into its own commit message and
  go green. That is a workflow reciting a justification nobody authored, and it
  would pass every future raise whatever its size — the gate deleting itself while
  still appearing to run.

  **What this loosens, stated plainly.** A hand-edited raise of the floor file
  within tolerance and adding no tool now passes, where it used to be refused.
  That is the permission `#1483` already granted the same move on a branch, and it
  buys the editor nothing: the branch gate weighs the measured catalogue against
  its merge base and never against this file.

  **A tool raise is untouched** on all three gates, which is the half of the rule
  that was always doing the work.

  The `#1583` property test grows the third gate: one table of nine inputs, three
  functions, asserted to give one answer about whether a sentence is required. A
  rule written three times agrees until it does not, and each place it is written
  is a place it can be fixed in isolation — which is what happened.
