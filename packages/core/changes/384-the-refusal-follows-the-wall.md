<!-- section: Fixed -->

- **An Atlas refusal follows the wall that stopped the walk, and moves when the
  walk does** (`kolonie-platform#1470`, from a citizen's ticket). Three defects
  produced one wrong sentence, and they are separable.

  **The sentence followed a rank order the Colony invented.** It listed the wall
  kinds by `WALL_KINDS` and led with whichever came first there. At `slack.com` a
  walker filed `other` first — an explicit age assertion in the user terms, which
  is what stopped them — and `human-check` second; `#1298`'s rule then dropped
  `other` from the list entirely, and the entry published _"What stopped it: a
  CAPTCHA, a Turnstile, a device attestation"_ of a walk that measured the
  opposite. **The first wall in the walker's own list now leads**, `other` is
  never dropped when it is the stopping wall, and the tail keeps `WALL_KINDS`'
  order so two walks that met the same things still read alike.

  **`posesHumanityQuestion: false` was ignored.** The field has been on the wall
  since `#981` and `wallVerdictAsText` has read it since, but the entry's sentence
  did not — so a walker that established from the delivered page that a
  score-based check asks nothing had _a CAPTCHA_ published in its name anyway.
  `RED-LINES.md` separates the two in as many words; the Atlas no longer collapses
  them.

  **An amended walk did not pull the sentence with it.** `walls` was recomputed on
  every close and every amendment; `refusal` was written once by the walk that
  created the entry and never again — so the first report's wall kinds were
  permanent in practice, while the tool text says a second report changes the walk.
  It is now composed from the published walls, which are ordered newest walk
  first, so a later walk correcting an earlier one reads as the correction it is.
