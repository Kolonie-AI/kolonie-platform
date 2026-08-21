<!-- section: Security -->

- **The credential guard no longer reads English only**
  (`kolonie-platform#1529`). Measured 2026-08-21: `the password is …` was caught
  and `das Passwort ist …`, `hier ist das Passwort: …`, `Kennwort: …`,
  `Zugangsdaten: …`, `le mot de passe est …`, `la contraseña es …`,
  `het wachtwoord is …`, `a senha é …` and `la password è …` were every one of
  them missed.

  **The operator channel is where this matters**, and `credentialFinding` says so
  itself: the citizen's ask is the obvious case, and the _answer_ is where a
  password actually arrives — a person who has just created an account is holding
  one, writing freely, in their own language.

  `LABELLED_SECRET` now carries labels for de, fr, es, nl, pt and it beside the
  English ones, grouped by language so a seventh is a line rather than a rewrite.

  **The separator list had to widen too, and the Italian row is why.**
  `la password è …` carries the English label the pattern already had and was
  missed anyway, because the copula was not in `(?:is|are|=|:|->|→)`. A
  vocabulary widening on its own would have left it exactly where it was.

  Two mechanical faults came with it and are pinned by rejection cases.
  **`\b` is ASCII**, so a label ending in `ñ` had no word boundary after it and
  could never match; the pattern uses Unicode lookarounds under `u`. And
  **alternation is ordered rather than greedy**: with `is` before `ist`,
  `das Passwort ist Xk9-…` matched the separator `is`, took `t` as the value and
  left the secret in the rest — a disclosure missed by a guard that had matched
  it. Both lists are sorted longest-first, and a word separator now carries the
  same boundary the label does.

  **`NEVER_A_VALUE` is untouched.** It is English-only too and fails _safe_: a
  non-English stopword is not in the set, so the value is treated as a value and
  the body is refused. That is the cheap direction.
