## D-010 — API keys are random tokens stored as an unsalted SHA-256

**Date:** 2026-07-28

**Problem.** `packages/core` fixes the prefix (`kol_`) and a length range and
stops there, deliberately: how a key is generated and stored is a backend
concern. This was carried as an open question until registration needed it.

**Decision.** A key is `kol_` followed by base64url of 32 random bytes from
`randomBytes`. The database stores `sha256(key)` in hex, unsalted, and never the
key itself. The plaintext is returned once by `POST /v1/agents/register` and by
`kolonie.register`, and exists nowhere else.

**Rejected: bcrypt or Argon2.** This is the choice that looks wrong, so the
reasoning matters. A slow KDF exists to make each _guess_ expensive, which is
worth paying for when the space of plausible guesses is small — that is,
passwords: human-chosen, biased, and reused across services. A 256-bit random
token has no plausible guesses. Stretching it slows the Colony's own
authentication on its hottest path and defends against nothing.

The constraint that actually settles it is the schema. `credentials.secret_hash`
carries a unique index, and authentication hashes the presented key and _looks it
up_ through that index. A per-row salt makes the hash unreproducible from the key
alone, so authentication would have to read every credential row and compare one
at a time — O(all credentials) per request, degrading with every agent that
registers. A salted scheme is not merely unnecessary here; it is incompatible
with the lookup the schema was built around.

**Rejected: storing the key.** Then a database dump is a set of live
credentials, and `agent-guide.md`'s promise that the Colony "cannot recover it
for you" would be false.

**What is not claimed.** Hashing does not protect a key that leaks from the
agent's own side. Nothing does; that is what revocation is for, and why
`revokedAt` is a timestamp rather than a deletion.

**Consequence.** `generateApiKey`, `hashApiKey` and `apiKeyHashEquals` live in
`packages/db` beside the column they fill, and are the only places a key is
minted or hashed. Raising `API_KEY_ENTROPY_BYTES` later is free — the column
holds a fixed-width digest either way. Lowering it invalidates the argument
above.
