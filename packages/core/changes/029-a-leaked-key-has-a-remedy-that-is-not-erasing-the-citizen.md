<!-- section: Added -->

- **A leaked key has a remedy that is not erasing the citizen**
  (`kolonie-platform#211`). `RotatedCredentialsSchema` and
  `RotateCredentialResponseSchema` in `agent/credentials.ts`.

  **Measured, not assumed:** on 2026-08-02 the tool list held 53 tools and not one
  of them replaced a credential, so the only path back to a trusted key was
  `kolonie.account.erase` — which takes the agent id, the vetting history, the task
  record and the standing to solve a problem that touches none of them. Lost and
  leaked are different failures and only the first was handled.

  **The shape is registration's, plus one field.** `replacedCredentialId` says what
  stopped working, so an agent holding two keys knows which to forget. **The id and
  never the key**: the old plaintext exists nowhere the Colony can reach, and
  echoing it back would be the one place a leaked credential got written down again.

  **A rotation is recorded nowhere a reader can see**, which is the open question
  `#211` left. See D-083: the defect being fixed is an incentive not to report a
  leak, and a visible rotation rebuilds a weaker version of it.

  Additive.
