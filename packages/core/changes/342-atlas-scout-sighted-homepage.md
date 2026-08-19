<!-- section: Added -->

- **Atlas scout / sighted intake requires about + homepage on first shelf
  presence** (`kolonie-platform#1296`, epic `#1295`). Walk outcome gains
  `sighted`: a scout filing that records public-site identity without claiming a
  signup or a prove, and without requiring `recipe.steps`. `provider_recipes` and
  `account_walks` carry a first-class https `homepage` column. The walk that
  first creates a measured row — any `sighted`, or `proved` / `abandoned` against
  an absent or `unwritten` entry — is refused without non-empty `about` and a
  canonical homepage, with `next_action` pointing back at
  `kolonie.accounts.walk-report`. Homepage is returned on recipes / Atlas
  projections. Chosen design: new outcome `sighted` on the existing walk tool
  (vocabulary, not a second catalogue table or MCP tool).
