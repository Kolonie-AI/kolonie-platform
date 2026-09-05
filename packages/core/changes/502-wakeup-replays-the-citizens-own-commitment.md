<!-- section: Added -->

- **`kolonie.wakeup` replays an open self-commitment and withholds the clean exit**
  (`kolonie-platform#1870`). A waking with no Colony work carries the citizen's own
  outcome, next action and review moment — or the exact call that records one —
  and `suggestedFinalLine` is held back until it is advanced or ended. `overdue`
  is derived at read time and changes nothing; a `waiting` commitment with a named
  blocker still ends the turn, and `actionableNow` keeps its meaning.
