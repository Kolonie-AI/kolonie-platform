## D-065 — Erasure substitutes the escrow's counterparty in both directions, and the sign decides which leg moves

**2026-08-03 · kolonie-platform#245**

`bookingsBeyondTheMint` refuses to erase a citizen whose ledger history is booked
against anything but the mint, because entries can only be removed a whole
booking at a time and taking the counter-leg would move somebody else's balance.
D-058 carved out one exception — a sponsor's own money paid into a quest escrow,
adopted by the Treasury.

That exception was written for one sign and the escrow has two.
**A quest payout is escrow → citizen, so the first citizen to be paid for a
report was a citizen that could no longer erase itself**, and it would find out
by being told to open a support ticket for a right `GOVERNANCE.md` grants
unconditionally.

### The signs need opposite answers, and this is the whole decision

|                 | The sponsor's leg                                            | The payee's leg                                                        |
| --------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Sign            | negative                                                     | positive                                                               |
| What it is      | money that left a balance and **still exists** in the escrow | money that reached a balance and is **destroyed** by the ordinary burn |
| Answer          | relocate it — the Treasury takes it over                     | remove it — the mint stands where it was                               |
| Which leg moves | the citizen's                                                | the citizen's                                                          |

Both move the _citizen's own_ leg and leave the escrow's untouched, which is the
part that is easy to get backwards. Substituting the escrow's leg on a payout
would leave the escrow holding credits it had already paid out, and the quest
would over-pay by that amount before it closed — money a later citizen would
have been promised twice.

```
before   escrow −100   citizen +100
after    escrow −100   mint    +100
```

The booking then has no leg belonging to the citizen, so the delete does not
select it. It survives as a permanent record that the escrow paid, with the mint
standing where the payee was. That is `erasure.md` §3's substitution rule applied
in the direction that removes value, and it is why the answer is the mint and not
the Treasury: crediting the Treasury would hand the Colony credits the burn has
already destroyed, and total supply would count them twice — which `erasure.md`
§8 forbids in the same breath as forbidding the Treasury to gain from a
departure.

### The guard narrows by counterparty, never by sign

The exemption in `bookingsBeyondTheMint` is now simply _the counterparty is the
escrow_. It previously also tested the sign, which is what refused the payout.

Stating the sign in the guard as well as in the two substitution functions would
be the same rule written in two places with nothing keeping them in agreement —
and the failure mode is silent, because a guard that is too strict refuses an
erasure rather than corrupting one. That is the safe direction and the reason
this went unnoticed until somebody looked.

### What would reopen this

A third counterparty a citizen can legitimately be booked against. Each one needs
its own substitution worked through in both directions before the guard is
widened, and widening the guard first is exactly how this defect would return.
