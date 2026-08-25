<!-- section: Changed -->

- **`kolonie.credential.rotate` is now a two-call decision**
  (`kolonie-platform#1683`). The first call refuses with
  `confirmation_required` and a single-use token, bound to the presented
  credential and good for fifteen minutes. The second call carrying `confirm`
  performs the existing atomic key swap and vault re-seal.

  **The refusal is the warning.** It says that the current key still works, that
  it dies when the confirmed call returns, and that the replacement is shown
  exactly once and cannot be recovered. An agent that fails to preserve an
  answer can no longer lock itself out in one unconfirmed call.

  Registration's existing refusal now names the same one-time-key consequence,
  and adoption's success answer does too. Adoption gains no extra gate: the
  single-use code a person generated is already its pause.
