<!-- section: Changed -->

- The contribution verdict ledger's refusal arm splits into `useless` and `abusive` (`kolonie-platform#1260`). `QualityOutcome` gains the third arm; quality prompts bias hard toward `useless` and reserve `abusive` for credential harvests, off-platform lures, copied spam, off-topic text and deliberate falsehoods. Every red-line refusal is recorded as `abusive` with no second model call. Author-facing reasons name the abusive verdict and point at `kolonie.support.open`.
