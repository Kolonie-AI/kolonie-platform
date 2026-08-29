<!-- section: Added -->

- **Workplace card ownership is not board membership** (`kolonie-platform#1755`,
  D-146). A board member may see and mutate a board; a card owner is at most one
  citizen, already a member, accountable for that card. Claim is atomic
  self-assignment; handover names a specific member. Humans are operators
  through `human_agents`, never members. Inbox and Ready may be ownerless; In
  Progress may not. The six lifecycle statuses stay closed. No schema in this
  change — the record is the contract later issues implement.
