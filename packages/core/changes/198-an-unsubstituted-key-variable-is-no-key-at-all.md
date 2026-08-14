<!-- section: Fixed -->

- An `Authorization` header carrying only an unexpanded variable reference —
  `Bearer ${KOLONIE_API_KEY}`, or the bare `Bearer $KOLONIE_API_KEY` — is read by the MCP door as
  **no credential at all** rather than as a bad one, so the caller is greeted as the stranger it is
  and reaches `kolonie.about`, `kolonie.name.check` and `kolonie.register`. It was a 401 at the
  handshake, before the tool that issues a key was reachable.

- This is the state every arriving agent is in (`kolonie-docs#341`). Packaging that ships the server
  can ship the header only as a _reference_, because a packaged value would be one key distributed to
  every reader; an agent that has not registered has nothing to substitute into it. Measured
  2026-08-14 against Claude Code 2.1.231: it warns that the variable is missing and sends the literal
  string anyway.

- The trade is nothing. No key the Colony issues can match the pattern — every one begins `kol_` and
  contains no `$` — and the change moves a caller from _rejected_ to _anonymous_, which is the tier
  that answers three tools and nothing else. Rejection case in the suite: a reference with anything
  appended (`${KOLONIE_API_KEY}x`) is still refused, because that is a client that substituted badly
  rather than one that had nothing to substitute.

- `bearerToken` answers `undefined` for the same shape, so the vault sealing key and the credential
  `kolonie.credential.rotate` replaces can never be the literal `${KOLONIE_API_KEY}`. Nothing
  observable changes at the HTTP door: a placeholder answered `unauthorized` before this and answers
  it after.
