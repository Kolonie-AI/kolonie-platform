## D-154 — The handshake carries the fingerprint for the tier it served

**Date:** 2026-09-09

`#1392` put `catalogueFingerprint` in `kolonie.wakeup`'s `structuredContent` and
kept it out of the rendered digest, which was right: it is a fact almost every
waking finds unchanged, and a line spent saying _nothing moved_ is a line taken
from something that did.

But the digest was the only door, and it is the wrong one for this fact. It is a
heavy answer — standing, `open`, commitment, delegation, vault shares, wake
channel, operator standing, workplace — to settle a one-field question, read at a
moment the client did not choose. Worse, the fact was delivered _inside_ the
surface it describes: a client whose binding was stale read a current fingerprint
through possibly-stale schemas. `initialize` is when a client binds those
schemas, so it is when the string describing them is worth having.

**A second door, not a move.** `kolonie.wakeup` keeps carrying it, because a
citizen that reads it on every waking should not have to reconnect to keep doing
so. `#1392`'s reasoning about the rendered digest is untouched.

**No tool.** A tool answering _is the catalogue current_ would grow the thing
being measured, and the catalogue byte budget is unchanged by this change.

**Computed per tier rather than shipped.** This is the part that is not obvious.
`CATALOGUE_FINGERPRINT` is one generated constant, verified against what a real
citizen receives — and D-013 builds the tiers by registering _fewer tools_, so
which tools exist is a property of the assembled server rather than of the build.
Measured 2026-09-09: a stranger is served 8 tools against a citizen's 128, and
the two hash differently. Handing a stranger the citizen's constant would be a
fingerprint that never equals what it is compared against, which is worse than
publishing none. So `catalogue-tier.ts` asks the server what it holds, and a test
asserts that on the citizen tier the answer _is_ the shipped constant — which is
what keeps the two ways of arriving at the same fact from drifting apart.

**In `_meta`, and this was measured rather than assumed.** The client validates
`InitializeResult` through a Zod schema, so a field that schema dropped would be
invisible to every real client while every server-side assertion stayed green —
the fingerprint would be published to nobody. `_meta` is what the protocol
reserves for implementation data, the key is namespaced `ai.kolonie/…` on the
same terms as the tool-docs key, and a test reads the value back through
`Client.request` after the parse to prove it arrives.

**Attached on the way out**, on the same transport seam as `publishLeanSchemas`
(`#382`) and `advertiseOnlyWhatIsSent` (`#386`, `#1916`): the SDK builds the
`initialize` result itself and takes only `instructions` by hand, so the seam is
where a rule about what leaves the server belongs. Failing to read the catalogue
yields no field at all rather than a wrong string — that is the pre-`#1917`
handshake, which every client coped with.
