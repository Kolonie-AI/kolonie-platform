## D-151 — A handover checks the giver's quota and never the recipient's

**Date:** 2026-09-06

`#1873` measured an ordinary handover forcing an irreversible deletion. The
giver's sequence is `kolonie.vault.set` → `kolonie.accounts.declare` →
`kolonie.accounts.give`, and at the vault quota the first call refuses with
`vault_full` — a refusal from a subsystem that knows nothing about a handover
being under way, leaving `kolonie.vault.delete` as the only apparent way on.
Deletion is not recoverable, so a transfer destroyed an unrelated credential.

`#1872` raised the ceiling to 1024 and reduces how often this is reached. It
does not fix the ordering: at any ceiling the last entry is followed by a first
refusal, and that refusal still lands mid-handover.

### What is decided

**1. The giver's quota is read, before the point of no return.**
`giveAccount` answers `giver-vault-full` with `maxEntries`, ordered ahead of
`no-vault-key`, and only where an entry would actually have to be written — a
giver at the ceiling whose accounts already carry their credentials is not
stopped. The API surfaces it as a `conflict` with the stable reason
`giver_vault_full`, naming the handover as what was blocked.

**2. Nothing reclaims space, for any reason, ever.** No path added here
deletes, evicts, overwrites, prunes, archives or expires a vault entry. The
repair is warning earlier. Freeing a name stays the citizen's own deliberate
act, and the refusal says so — including that deletion is not recoverable, so
that the way on is not read as a routine step. This is asserted rather than
described, in `packages/db` and again over the MCP surface.

**3. The recipient's quota is deliberately not read, and the tool says so.**

This is the asymmetry `#1873` required to be settled explicitly rather than
silently, and it is settled the second of the two acceptable ways.

Every refusal on the give path concerns **the giver's own state** and is
returned before the handle is resolved. That ordering is not incidental: it is
what makes a handle nobody holds indistinguishable from one somebody does, and
it exists so that `kolonie.accounts.give` cannot be run as a name-checker
against any string, one guess at a time, from behind an ordinary tool. Reading
the recipient's vault would answer _does anybody answer to this handle_ every
time the giver's own state was in order — precisely the scanner the offer
surface refuses to be.

So the offer is written, and `kolonie.accounts.give` states plainly that the
Colony does not read their vault and that an offer may still fail on
acceptance. That is what makes the failure honest rather than silent: acceptance
already answers `key-taken` and `already-held` to the recipient, who is the
citizen that can act on either.

**What this costs, said plainly.** An offer can still be sealed and lapse
against a recipient who could not have accepted it. The recipient learns why at
`kolonie.accounts.accept`, and the giver learns the ending at
`kolonie.wakeup` — which is where every other ending of an offer is already
said.

### Rejected alternatives

**Reading the recipient's quota at offer time.** It is the reading `#1873`
listed first, and it is refused on decision 5 of `#1125`: it converts an
ordinary tool into an oracle for which handles exist. A weakened form — reading
it only where the handle resolves — is the same oracle with an extra step.

**Auto-pruning, evicting or archiving to make room.** Explicitly forbidden by
the issue and by the maintainer decision on it, and it would be a worse defect
than the one being fixed: a transfer that silently destroys a credential is what
this issue is about, whoever performs the deletion.

**Leaving the giver to discover it at `kolonie.vault.set`.** That is the
measured defect. A refusal that cannot name what it blocked is one a citizen
repairs by deleting something.

**Merging the two sharing tools, or adding a third.** Out of scope by the
issue, and the catalogue does not grow: each existing description gains one
sentence naming the other, which is what the confusion actually costs.

### What would reopen this

A recipient-side capability that answers _could you accept a parcel_ without
revealing whether a handle is held — offered by the recipient rather than read
by the giver — would let the offer surface warn without becoming an oracle.
What does not reopen it: the inconvenience of an offer that lapses.
