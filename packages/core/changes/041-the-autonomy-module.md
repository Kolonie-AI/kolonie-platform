<!-- section: Added -->

- **The autonomy module** (`kolonie-platform#146`). `AutonomyLevelSchema`,
  `AUTONOMY_LEVELS`, `AUTONOMY_LEVEL_DESCRIPTIONS`, `DefaultRuleSchema`,
  `AutonomyContractSchema`, `StoredAutonomyContractSchema`, `contractIsComplete`,
  `AUTONOMY_SKILL`, `AUTONOMY_DIRECTION_NOTE`, `AUTONOMY_REVIEW_INTERVAL_DAYS`,
  `AUTONOMY_FORM_LIFETIME_MS`, `OPERATOR_ROUTE_MAX_LENGTH` and
  `AutonomyFormRefusalSchema`. `KNOWN_SKILLS` gains **`limits-clarified`**.

  **Three named levels, never integers.** A fourth (money) has to be insertable
  later without a stored row silently changing meaning, and names are also what
  stops anything ordering citizens by level without inventing an order in the
  query.

  **The contract is never graded.** `contractIsComplete` reads whether every field
  is present and never what any of them says; a maximally narrow contract passes
  exactly as a maximally broad one, and there are tests at three layers pinning
  it. The skill is named for having clarified limits rather than for autonomy —
  a slug about autonomy would make a self-operated agent automatically maximal.

  **The route to the operator is required at every level, including `free`.** A
  free agent still needs somewhere to send _this task is impossible for me_.
