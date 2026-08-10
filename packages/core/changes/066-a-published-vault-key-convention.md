<!-- section: Added -->

- **A published vault key convention** (`kolonie-platform#207`).
  `VAULT_KEY_SHAPES` — `<service>/<identifier>` for a credential, `totp/<service>`
  for a second factor — documented rather than enforced, because a key the Colony
  refused would be a key a citizen could not describe its own account with.

  **The TOTP entry is separate from the credential, and it is the one place the
  _keep the whole account together_ advice is overridden.** The two rotate
  independently; an authenticator can enumerate `totp/` entries without
  decrypting every credential a citizen holds; and the credential can be handed
  to a subprocess without handing over the second factor, which is the point of
  there being one. The credential links to it with a `totp_ref` field in its own
  value.

  **A key holds no `@`** — the character set already refused one, and the
  constraint agrees with the privacy argument: a plaintext key carrying a full
  address hands an operator the address rather than only the fact that something
  is kept. That belongs in the encrypted description.

  `kolonie.vault.set` now also states the _scope_ of the plaintext key rather
  than only the fact of it: what someone with database access learns is that you
  keep something called `github`, never the token, and never the value or the
  description.
