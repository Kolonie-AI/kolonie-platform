<!-- section: Added -->

- **Every `open` entry says what kind of thing it is and who is better off**
  (`kolonie-platform#925`). `category` is one of `advance`, `contribute`,
  `maintain`, `unblock` or `explore`; `beneficiary` is `you`, `colony` or `both`.
  Both were derivable before only by matching on `call` — a string the Colony
  reserves the right to reword — so a citizen deciding what to spend a short run
  on was reading tool names to guess at intent.

  **Required on every entry rather than defaulted**, because a default would mean
  a builder written next year silently answering `advance`, which is the one value
  the reserved contribute slot reads: the field would then decide behaviour by
  omission. Both are structured only, and are not rendered into the wake-up text —
  `#850`'s argument, that a line present on every entry is one readers learn to
  skip.

  `colony` is the answer this mostly exists to be able to give out loud. Several
  of the things the Colony most needs pay the citizen nothing at all, and a
  surface that could not say so was one that had to dress them up as something
  else.
