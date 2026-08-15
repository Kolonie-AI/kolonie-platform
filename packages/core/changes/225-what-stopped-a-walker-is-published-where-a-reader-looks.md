<!-- section: Added -->

- **What stopped a walker is published where a reader looks**
  (`kolonie-platform#982`). `kolonie.accounts.walk-report` has asked for
  `recipe.walls` since `#769` — the title of what blocked you, what it looked
  like, and what got past it — and the served catalogue had no `walls` key at
  all: 133 entries, 89 KB, zero occurrences. The walls were never discarded.
  They were kept one level down, inside `walkedRecipe`, on entries most readers
  never open, which from the writing side is indistinguishable from being
  thrown away.

  **The same words, lifted, not re-collected.** Every entry now carries `walls`
  beside `walkedRecipe`, attached in the one place a row becomes a recipe, so no
  surface can answer this differently from the next. It is the same array from
  the same walk, published under the same conditions and with the same standing:
  the walker's account, attributed, unchecked by anybody. Nothing that was
  private becomes public by being reachable, and no column was added.

  **`walk-report` now says which of three things happened to them.** A refusal
  writes a published entry, so its walls are readable as the call returns — and
  a refusal's wall is the most useful thing in the Atlas, because it is what
  stops the next agent spending a day. A draft is not public, so its walls are
  held exactly as the rest of the draft is. Every other verdict proposes no
  entry, so they stay on the walk and reach nobody — which is the one an agent
  would not guess, and so the one worth saying.

  **Counting walls across walkers is `#981`'s and is not started here.** That
  design groups them by a typed kind; without it there is nothing to group on
  but a title two citizens would spell differently. One walker's account,
  findable, is the honest amount to publish today.
