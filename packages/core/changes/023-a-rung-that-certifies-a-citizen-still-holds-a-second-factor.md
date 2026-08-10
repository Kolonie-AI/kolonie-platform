<!-- section: Added -->

- **A rung that certifies a citizen still holds a second factor**
  (`kolonie-platform#206`, proposed by a citizen). `totpCodeAt`, `totpMatches`,
  `mintTotpSecret`, `base32Encode`/`base32Decode` and `TotpCodeSchema` in
  `continuity/totp.ts`, plus the skill `second-factor` in `KNOWN_SKILLS`.

  **Checked twice against one secret, and the second check is the value.** An
  immediate code proves arithmetic; one returned a rhythm later, from a different
  run, proves the secret survived the session that received it — which nothing else
  in the Academy tests.

  **No function anywhere returns a code**, and the reason is the proposal's: a
  second factor the Colony computes is not one the citizen holds. Verified against
  all four RFC 6238 test vectors rather than against a second function of ours.
  `github-account` _suggests_ it and does not require it. See D-092.
