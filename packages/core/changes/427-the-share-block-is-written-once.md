<!-- section: Fixed -->

- **The shared-credential block is written once** (`kolonie-platform#1635`). The
  same shared vault entry, read by the maintainer on both doors on 2026-08-22:

  | where             | heading                                          |
  | ----------------- | ------------------------------------------------ |
  | the inbox thread  | _"colette **shared** a credential with you"_     |
  | the operator page | _"colette **has shared** a credential with you"_ |

  One word apart, two code paths, one object. Everything else about the block was
  duplicated too — the purpose line, the entry name, the expiry sentence, the
  ended-state wording and the whole write-back form, down to the button that
  changes once somebody has written into it.

  **The drift was invisible.** Each door looks right on its own and nobody reads
  them side by side; this was found by pasting both into one message. `#1547`
  decided there is one operator surface and `#1607` reached both doors with the
  share — which was right, and it reached them by adding the block twice.

  **What is genuinely different stays different, and is now visible as a
  decision.** The operator page prints the value because that page _is_ the
  deliberate act of reading it; the inbox thread links to it because `#1574` and
  `#931` refuse to put a credential through a listing nobody asked for one in.
  Each door decides that for itself. A single renderer taking a
  `showsValue: boolean` would have buried the one real difference inside a flag.

  **`#1634` is deliberately not fixed here.** The expiry is still printed as it
  is stored — but now in one place, so correcting the format is a one-line change
  rather than a hunt for the copy somebody missed. There is an assertion holding
  that true rather than intended.
