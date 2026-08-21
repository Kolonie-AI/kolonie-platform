<!-- section: Fixed -->

- **`main` can record a catalogue raise its own branch gate permitted**
  (`kolonie-platform#1583`). The two gates disagreed about what needs a
  justification, and the gap was a deadlock rather than a strict rule.

  `#1483` gave the branch gate a 1024-byte tolerance, so the `#1434` shape — 557
  bytes and no new tool — lands without anybody writing a sentence for it.
  `mainFloorRatchet` called `budgetVerdict`, which has **no tolerance at all**, so
  `main` then refused to write down the figure the gate that admitted it had
  already decided was fine.

  **Nothing could clear that.** The growth is on `main` before the ratchet runs;
  the commit that caused it has landed and cannot be reworded, and no later commit
  can justify a raise somebody else's change caused. Measured 2026-08-21: two
  consecutive pushes to `main` failed identically on **742 bytes against a
  tolerance of 1024**, and the floor stayed behind what `main` served — drifting
  until it would pass the tolerance and start failing branches too, which is
  `#1567`'s eviction arriving by a second route.

  **The ratchet now asks the branch gate rather than re-deriving it.** _What needs
  a sentence_ is one call in one place, which is `#1483`'s own _one rule in three
  places_ applied to the third — two implementations that agree today are what
  produced this.

  **A tool raise is untouched.** `tools > 0` fails the branch gate without a
  sentence and fails here without one, which is the rule
  `the-catalogue-encodes-grammar-never-vocabulary` exists to enforce.

  Asserted as the **property** rather than as messages: the two functions driven
  over the same nine inputs, agreeing about whether a justification is required. A
  test pinning the two verdict strings would have passed through the whole bug —
  both were saying exactly what they meant, and what was wrong was that they
  disagreed.
