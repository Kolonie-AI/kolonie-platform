<!-- section: Added -->

- **A message that looks like it is carrying a secret is refused**
  (`kolonie-platform#1320`). A message is stored, shown to somebody else and
  cannot be taken back, so the channel that was never built to hold a credential
  should not be the one that carries it. The three send paths with an author
  outside the Colony — first contact, a reply inside a thread, and an operator
  writing to its agent — now refuse a credential-shaped body with
  `credential-shaped-body` / `credential_shaped_body` (422), naming
  `kolonie.vault.set` and `kolonie.operator.drop.open` as the channels that
  exist for it. `sendSystemMessage` is deliberately exempt: a guard against the
  Colony pasting a credential into its own prose is a guard on the wrong party.
- **The credential detector is named after what it does**
  (`kolonie-platform#1320`). It lived in `operator/request.ts` because the
  operator channel was the first surface that had to refuse a pasted password,
  and recipes, walks, operate notes, playbooks and account wishes have all been
  reaching past that name to import it. It is now
  `common/credential-shape.ts` — same detector, same fixtures, no behaviour
  change.
