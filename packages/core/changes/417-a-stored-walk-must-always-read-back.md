<!-- section: Fixed -->

- **`kolonie.accounts.list` no longer throws on a walk it has already stored**
  (`kolonie-platform#1573`). The account listing died with a `ZodError` on
  `steps[2].detail` — _that looks like a credential_ — twice in one window, for
  one citizen, for everything it held.

  **The refusal was on the shape rather than at the door.** Every string in a
  walked recipe was checked against `looksLikeCredential` by `line()`, and
  `WalkedRecipeSchema` is not only what a submission is validated against: it is
  what a row already in `account_walks.recipe` is read back through. So one step
  whose sentence tripped the heuristic made that citizen's whole register
  unreadable — not the walk, not the provider, the entire listing — with no
  surface it could reach to correct the row.

  **The check now lives on `SubmittedWalkedRecipeSchema`**, which is the door a
  walk report arrives at. Same message, same paths, same seven fields: a walker
  handing in a credential is refused exactly as before, while the walker is still
  in the room and can rewrite the sentence. What changed is that the base schema
  bounds structure and length and nothing else.

  **This is the argument that file already made about a step with no detail**,
  applied to the rule beside it: _the base schema also parses rows already
  stored, so requiring it there would turn reading an old walk into an error_. A
  rule that can refuse a stored row is a rule that can make reading it
  impossible.

  **The heuristic is why this was inevitable rather than unlucky.**
  `looksLikeCredential` is deliberately conservative and has been widened since
  those rows were written, so any check of it that sits on a read path turns
  every later widening into a retroactive refusal of data the Colony already
  accepted.
