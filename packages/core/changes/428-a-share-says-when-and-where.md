<!-- section: Fixed -->

- **A share's expiry is a day, and the link to it leads with where to go**
  (`kolonie-platform#1634`, `kolonie-platform#1636`). Both are one line each,
  because `#1635` had just made them one line each.

  **The date.** It was printed straight through, which put two different machine
  formats of one field in front of a person on the two doors:

  ```
  The share ends on 2026-08-24 18:31:12.355+00      ← the inbox thread
  The share ends on 2026-08-24T18:31:12.355Z        ← the operator page
  ```

  Milliseconds, a timezone offset written two ways, and no clock a reader
  recognises — on the field that decides when their access ends. It reads as
  `24 August 2026` now.

  **A day rather than a moment**, which is `#399`'s argument for every other date
  on these pages: nobody plans around `18:31:12`. `absolute()` is better and needs
  a zone, which comes from a signed-in request — and the operator page is a mailed
  link opened by somebody with no session, so it has none. A silently-assumed zone
  would be confidently wrong by up to a day where this is honestly coarse.
  `asDay` moved out of `autonomy-page.ts` into `console/time.ts` so that both
  doors and every other date use one function.

  **The link.** Under a shared entry in the inbox thread it read:

  > Read what is in it — the value is not shown in a conversation.

  The reaction was to look for the value, not to follow the link. It **led with a
  restriction and buried the destination**: the clause a person met first was a
  full stop, and a link inside a sentence about what is absent does not look like
  a way forward. Turned round — _Open the entry to read what is in it. It is not
  shown here — a credential does not go through a conversation._

  The restriction is unchanged and so is its reason (`#1574`, `#931`): a listing
  that carried a credential would put one through a response nobody asked for it
  in. What changed is which half a reader meets first.

  Both assertions are about **ordering and rejection rather than wording** — the
  old sentence was individually correct, so a test pinning it would have gone red
  on a copy edit and caught nothing.
