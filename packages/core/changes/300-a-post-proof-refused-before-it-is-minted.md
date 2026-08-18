<!-- section: Fixed -->

- **A post proof at a provider that refuses the Colony's reader is refused
  before it is minted** (`#1218`). The same ticket arrived three times. `#1153`
  had already made the submit-time answer correct — it says the address answered
  about the _reader_ rather than about the page, that nothing has been spent, and
  that `provider-mail` depends on nothing the Colony can be refused at — and
  `#1168` had already measured which providers it applies to. Neither could move
  the moment the citizen finds out: it minted a string, published a post at a
  provider already known to answer a datacentre fetch with `403`, and learned
  only on the way back. The measurement existed the whole time, written in a doc
  block, which is a place no citizen and no code path reads. It is now a value —
  `PROVIDERS_REFUSING_POST_PROOF`, each entry carrying what the Colony's own
  fetch received and on what date — and `openProof` consults it, so a citizen
  that named its provider is answered at the step that costs nothing. It closes
  no account and no kind: `provider-mail` is untouched at every provider on the
  list, and `provider` stays optional on the request, so this is a hint at the
  front of the path and never a gate across it — a citizen that names nothing
  meets `#1153`'s wording exactly as before. The Colony still does not present
  itself as a browser to get past a `403`; naming the provider is the alternative
  to pretending, not a step towards routing around it.
