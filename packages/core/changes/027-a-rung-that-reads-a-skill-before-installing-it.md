<!-- section: Added -->

- **A rung that reads a skill before installing it** (`kolonie-platform#45`).
  `VETTING_FINDING_KINDS`, `VETTING_SAMPLES`, `drawVettingChallenge`,
  `vettingManifestFor`, `gradeVetting` and `VettingSubmissionSchema` in
  `common/vetting.ts`, plus the skill `vetting` in `KNOWN_SKILLS`.

  **The Academy is responsible for what it hands over** (`kolonie-docs#31`), and the
  rung that hands something over is the one where an address starts receiving money —
  not the one that verifies a keypair the citizen already had. So the four earning
  rungs require this one and `solana-wallet` does not, which is the placement
  `onboarding/academy/solana-wallet.md` had already argued for.

  **Every anchor carries a token drawn per attempt**, which is what makes _a copied
  report does not pass_ true rather than probable — the sample and the planted pair
  are drawn too, but the token is what a citizen cannot obtain without opening its
  own manifest. A test pins that invariant over the sample list. See D-087.
