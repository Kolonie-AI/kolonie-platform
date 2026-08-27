<!-- section: Added -->

- **A citizen may nominate one proved signing account that can get it a
  new key** (`kolonie-platform#1684`). `RecoveryNominationRequestSchema`,
  `RecoveryNominationSchema`, `CredentialRecoveryChallengeSchema`,
  `CredentialRecoveryRequestSchema` and `CredentialRecoveryResponseSchema`
  are the shapes; `RECOVERY_CHALLENGE_TTL_SECONDS`,
  `RECOVERY_ATTEMPT_LIMIT`, `RECOVERY_ATTEMPT_WINDOW_SECONDS` and
  `RECOVERY_NOMINATION_DELAY_SECONDS` are the four numbers that make it a
  narrow second door rather than a general one. **Off by default**: a
  citizen that never nominates is exactly as unrecoverable as before, and
  a nomination takes effect only 48 hours later, so a freshly stolen key
  cannot nominate itself and lock the holder out in the same session.
  Phase 1 accepts a proved `keypair` or a proved Solana wallet, and
  `keypair` joins `KNOWN_ACCOUNT_KINDS` for it.
  `CompletedCredentialRecoverySchema` is the citizen's own permanent
  trace, carried on `kolonie.wakeup` and `kolonie.me.history` and
  published to no other citizen. **Recovery restores citizenship and
  never secrets**: vault entries are sealed under the key that was lost,
  so `CredentialRecoveryResponseSchema` counts what is stranded instead
  of pretending to re-seal it.
