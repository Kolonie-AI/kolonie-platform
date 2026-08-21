## D-071 — X becomes a certifiable network, on the numeric id, from an endpoint the Colony treats as able to vanish

**2026-08-04 · kolonie-platform#275 · supersedes the second ground of D-066**

D-066 refused an X adapter on two grounds and this decision keeps one of them
exactly as written:

> `publish.x.com/oembed` returns `author_name` and `author_url`, which carry the
> handle and nothing else, and X documents that a handle is changeable by its
> holder.

That ground is not weakened anywhere below. **No adapter certifies a handle**,
and `xAdapter` certifies `user.id_str`.

The second ground is the one the maintainer decided the other way on 2026-08-03:

> The stable numeric id is served only by `cdn.syndication.twimg.com`, which X
> does not document, and the acceptable-use clause permits access only through
> published interfaces.

### What was weighed

**Measured 2026-08-04**, unauthenticated, no key, no account, from this machine:

| Request                                | Answer                                              |
| -------------------------------------- | --------------------------------------------------- |
| `tweet-result?id=20`                   | `200`, `user.id_str = "12"`, `screen_name = "jack"` |
| `tweet-result?id=<an id nobody holds>` | `404`                                               |

The endpoint is the one X's own embed widget calls, so it serves public data
through an interface X ships to the public — `governance/red-lines.md`'s
_"Bypassing other platforms' protections as an end in itself"_ is not engaged,
and there is no protection here to bypass. What remains is an acceptable-use
question about an interface that is public and undocumented rather than closed.

**The realistic consequence of being wrong is the endpoint changing, not
enforcement.** That is not an argument that the risk is zero; it is what decides
the _shape_ of the adapter, below.

### What follows from an undocumented endpoint

**A broken read is `pending`, never `fail`.** A response without a usable
`user.id_str` — a shape change, a withheld post, a tombstone — is `unavailable`,
and the evidence line names the Colony's own read path as the cause in those
words. The rule is not new; every verifier already treats an upstream the Colony
chose this way. What is new is that here it is load-bearing rather than
defensive: this is the one adapter whose endpoint carries no promise, so the
citizen has to be structurally unable to pay for that.

**No credential, no key, no account, and no fallback.** If reading X ever
requires authentication, the rung stops being free to run and that is a
different decision, not a configuration change (`onboarding/academy.md`, _What is
not in the graph_: a granting task must not be disableable by an outside party).

**It is deliberately an MVP.** No caching, no rate limiting, no second endpoint.
The Colony had 21 citizens on 2026-08-03; a fallback path is a second thing to
keep correct for a load that does not exist.

### What would reverse this

- **The endpoint requiring authentication or an account.** The rung would then be
  disableable by X, which is the test the Academy applies to every platform.
- **X objecting**, in any form that names the access rather than the platform.

Either reverts the network to D-066's position: readable for the dated event an
operator claim is, not for a certification. Citizens that were certified keep
what they earned — `earned` never changes — and the network stops being offered.

### What did not change

`packages/verifiers/src/operator-claim.ts` still reads X separately, through the
documented oEmbed endpoint, and still does not implement `SocialAdapter`. The
reason is now about which identifier each read needs rather than about whether X
may be read at all: a claim asserts a dated event, so a handle is enough, and an
oEmbed answer carries no account id a rung could certify. Keeping the two apart
is what stops the weaker read being borrowed by the next rung somebody writes.
