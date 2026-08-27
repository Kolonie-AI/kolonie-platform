## D-145 — The workplace door validates a token and refuses an origin separately

**Date:** 2026-08-27

`#1727` implements the boundary `kolonie-docs`' `workplace-spa-uses-an-access-token.md`
settles: the workplace SPA authenticates to this API with a PKCE access token in
`Authorization: Bearer`, and the API validates its signature, issuer and
audience against deployment configuration. This record covers the three choices
that record left to the implementation.

### `jose` rather than a verifier written here

`auth0.ts` deliberately reads `/userinfo` instead of decoding the `id_token`,
and gives the reason: both carry the same claims, only one of them needs a JWKS
fetch, a key cache and signature verification written correctly, and the console
path walks it once a fortnight. **Neither half of that argument survives on this
path.** There is no code to exchange — the SPA holds a token the tenant already
minted — so `/userinfo` would be an outbound request per API call rather than
per sign-in, and the token is the only credential there is.

So the verification is real, and it is `jose`'s. It was already in the tree as
`@modelcontextprotocol/sdk`'s dependency at the same version, so declaring it in
`apps/api` added a line to `package.json` and one to the lockfile and nothing to
`node_modules`. `createRemoteJWKSet` is built once per process rather than per
request, because it caches the key set inside itself and refetches on an unknown
`kid`; building it per call would restore exactly the round trip the paragraph
above is about.

**The constraints are passed to `jwtVerify` rather than compared afterwards.**
Decoding first and checking `iss` and `aud` off the payload is the shape in
which somebody eventually compares a claim from a token whose signature was
never checked. Passed in, an unsigned token never reaches the comparison.

### A disallowed origin is `403` and a bad credential is `401`

The two say different things to the SPA and only one of them has a remedy the
SPA can perform. `401` means _sign the person back in_, which the decision
record requires it to do rather than rendering an empty board. `403` means the
browser is at an origin this API does not answer, which no amount of signing in
changes — it is a deployment fact.

The origin is therefore checked **before** the credential: a token harvested
into somebody else's page cannot be spent here even once, and the refusal costs
no key fetch and no signature check. The preflight is refused the same way, and
never as `401`, because a browser strips `Authorization` from a preflight — a
`401` there would refuse it for something it was never able to send.

**A request carrying no `Origin` is not a disallowed origin.** A same-origin
fetch and every non-browser client send none, so the credential decides and no
cross-origin read is permitted on the strength of it. Answering those `401`
would refuse the API's own callers on a header the browser controls.

### One refusal, and the origin is compared as a string

Every way of failing the credential check answers identically, byte for byte —
missing, expired, wrong issuer, wrong audience, forged signature, unusable
`sub`. That is `UNAUTHENTICATED`'s rule in `authentication.ts` restated at this
door and for its reason: any variation is an oracle, and the caller's next step
is the same in all of them. `workplace.test.ts` asserts the set rather than each
case, so a later refusal that reads better cannot be added without the test
noticing.

The allowed origin is compared with `===` and never parsed into a pattern.
Anything cleverer — a suffix match, a host comparison that ignores the port, a
regular expression — is the shape in which `workplace.example.evil` matches a
rule written for `workplace.example`. The field holds one origin and not a list,
because a list is a field somebody adds the console origin to, which is the
reflex the decision record names.

### What is configuration

`WORKPLACE_JWT_ISSUER`, `WORKPLACE_JWT_AUDIENCE` and `WORKPLACE_ORIGIN`, all
three or none, on the reasoning `auth0` in `server.ts` already gives for its own
three. With none set, no workplace route is registered at all and a caller gets
the router's `404` — a `401` would read as _your token is wrong_ about a door
that was never built.

**None of the three values appears in this repository, including in the tests.**
`workplace.test.ts` invents its own from RFC 2606 documentation names and
generates a signing key per run, which is what lets it perform a real signature
check while proving the values are configuration. The origin is told to the
process rather than derived from `CONSOLE_URL`: the workplace and the console
are deliberately different origins, and a default that reached for the console's
would be the reflex again, arriving as a convenience.

### What this does not decide

No work-item schema, no work-item endpoint, no API client generation, and
nothing about console authentication, which is untouched — nothing on this door
reads a cookie or sets one, and `workplace.test.ts` asserts both.
