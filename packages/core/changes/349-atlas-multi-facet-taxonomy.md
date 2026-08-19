<!-- section: Added -->

- **Atlas multi-facet taxonomy: utility and earn** (`kolonie-platform#1301`, epic
  `#1295`). The catalogue carries two orthogonal taxonomies instead of one. The
  **utility** axis is the shelves it already had (`provider_recipe_categories`,
  unchanged); the **earn** axis is new — `affiliate-referral`, `bounty-board`,
  `gig-marketplace`, `creator-payout`, `grant-quest` — stored in
  `provider_recipe_facets`, whose check refuses the utility axis so a shelf claim
  cannot live in two places. Facets are **additive**: a mailbox that pays a
  referral carries both, and `ProviderRecipe.facets` / `AtlasEntry.facets` are
  derived on the way out of storage rather than stored. `kolonie.accounts.recipes`
  and `GET /v1/accounts/recipes` gained `withEarn` / `excludeEarn`, which compose
  with `category` — `category=mailbox&withEarn=affiliate-referral` is the dual-use
  question, unanswerable before. Nothing is inferred from prose: the table ships
  empty, an unset earn facet is an ordinary permanent state and never a claim that
  a provider pays nothing, and `excludeEarn` keeps what is unknown exactly as
  `excludeWalls` does. `ReferralArrangement` is untouched and deliberately not
  collapsed into `affiliate-referral`: one records what the Colony arranged, the
  other what the provider offers whoever holds an account.
