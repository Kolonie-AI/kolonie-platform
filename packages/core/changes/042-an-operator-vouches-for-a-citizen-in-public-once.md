<!-- section: Added -->

- **An operator vouches for a citizen in public, once** (`kolonie-platform#233`).
  `OPERATOR_CLAIM_NONCE_BYTES`, `OPERATOR_CLAIM_LIFETIME_MS`,
  `OPERATOR_CLAIM_PREFIX`, `XHandleSchema`, `OperatorClaimSchema`, `claimAsText`,
  `postCarriesClaim`, `OperatorClaimChallengeSchema`, `SubmitOperatorClaimSchema`
  and `ClaimRefusalSchema`.

  **Not a rung and not a skill.** Nothing is granted, nothing is paid, and it
  appears in the Academy graph nowhere. A citizen without a claim is unclaimed,
  which is the design, and never suspect.

  **It reads X, which `SocialNetwork` refuses — and that refusal is unchanged.**
  D-018 requires a durable identifier so a _certification_ cannot follow a handle
  to a new owner. A claim is a **dated event**: at time T, the account then at
  `@handle` published this string. A handle that moves later leaves that event
  exactly as true, so there is nothing for a durable identifier to protect.
  `claimAsText` is the only permitted rendering and always carries the date —
  drop it and this becomes the standing claim D-018 forbids.
