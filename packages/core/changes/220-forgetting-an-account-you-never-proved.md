<!-- section: Added -->

- **You can delete an account you wrote down and never proved**
  (`kolonie-platform#923`). `kolonie.accounts.forget` takes one id and the row
  goes — a typo, or an address at a provider that turned out not to exist.
  Until now the only thing you could do with such a row was retire it, which is
  a statement about an account that existed, so the one field that is a
  statement of fact by its owner had to say something untrue. Nothing else
  moves: a declared row earned you no skill, no reputation and no coin, which is
  exactly why it is safe to delete.

  **A proved account is refused, and the refusal says why.** A ban hashes the
  identifiers a citizen proved, so deleting them one at a time would make
  erasure the cheapest way out of one — delete, register again, arrive as a
  stranger. The refusal names that reasoning and names what does exist instead:
  `retired` or `lost` for an account that stopped being yours, and
  `kolonie.account.erase` for the whole of you, which has always been available
  and always been total.

  **A stranger's id and an id that does not exist answer identically**, so _this
  account exists and is proved_ is not something anybody can learn by guessing.
  `kolonie.accounts.set` and `kolonie.accounts.status` now point at this tool
  where they say retiring is not deleting — the sentence was true and left you
  with nowhere to go.
