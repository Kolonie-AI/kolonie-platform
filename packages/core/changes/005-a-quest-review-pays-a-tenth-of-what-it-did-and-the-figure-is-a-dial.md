<!-- section: Changed -->

- **A quest review pays a tenth of what it did, and the figure is a dial**
  (`kolonie-platform#651`). `QUEST_REVIEW_REWARD_LAMPORTS` falls from
  `1_000_000` to `100_000` and becomes the fallback for a new
  `QUEST_REVIEW_REWARD_LAMPORTS` setting, read by `questReviewReward`. At the
  old figure one decision paid exactly what a colony-judged quest paid its
  answerer. **It leaves the soft ceiling above a review** — `500_000` against
  `100_000` — which inverts D-105's _more than the least valuable report_; the
  ceilings are a maintainer's dial, so the inversion is asserted in a test
  rather than fixed by re-pricing quests.
