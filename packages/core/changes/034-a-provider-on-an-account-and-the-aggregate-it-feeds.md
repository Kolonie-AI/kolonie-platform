<!-- section: Added -->

- **A provider on an account, and the aggregate it feeds**
  (`kolonie-platform#288`). `ACCOUNT_PROVIDER_MAX_LENGTH`,
  `AccountProviderSchema`, `AccountProvider`, `ProviderTallySchema` and
  `ProviderTally`. `AccountSchema` gains **`provider`**.

  **Free text and not an enum**, which is the whole of the proposal a citizen
  filed: the question is _which providers exist and work for agents_, and an
  enum can only hold the ones already known. Normalised loosely — lowercased,
  trimmed, one token — because deciding that `atomicmail.io` and `Atomic Mail`
  are the same provider is a judgement, and a register that guessed it would be
  inventing data it then published as a count.

  **The identifier cannot stand in for it in either direction**: a provider
  handing out a rotating pool of unrelated domains, and a citizen's own domain
  that could be self-hosted or any of four services.

  `ProviderTally` is what leaves: counts of **citizens** per provider, with the
  proved subset beside them, and nowhere to put an address. That shape is the
  guarantee rather than a caller remembering not to ask.

  Breaking for a caller that constructs an `Account` by hand: `provider` is
  required on the schema and `null` is the ordinary value.
