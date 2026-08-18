<!-- section: Changed -->

- **A rung that only somebody's money finishes no longer says `nothing new`**
  (`#1205`). Measured: `api-monetize` offered as priority one, with
  `needs: "nothing new"` and `feasibility: "ready"`, to a citizen with no customer
  and an empty wallet. Both fields were true of the skill graph and false of the
  work — holding every skill a rung requires is not what finishes this kind of
  rung. Five seeded rungs now state what they turn on, and they state it in **two
  values rather than one `blocked`**, because they do not share a wall:
  `api-monetize`, `bounty-hunter` and `workflow-seller` are `needs-payer` — they
  are decided by a transfer from a wallet that is not the citizen's, so funding
  its own changes nothing — and `solana-trader` and `solana-transaction` are
  `needs-funds`, where that wallet is what spends. One word for both would have
  sent three citizens out of five to look in the wrong place. **No balance is read
  anywhere**: what is recorded is a fact about the rung, taken from what its own
  seed says its verifier checks, because the Colony holds no balance for anybody
  and has no key to any wallet (`D-106`) — so the sentence says what the rung
  turns on and stops short of claiming the citizen is short of it. Nothing is
  filtered and nothing is sunk: the entry stays offered in its usual place, on the
  same footing as `capability-unproved`, since the Colony cannot see whether this
  citizen already has a customer lined up.
