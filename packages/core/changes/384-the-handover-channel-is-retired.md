<!-- section: Removed -->

- **`kolonie.accounts.handover` is retired** (`kolonie-platform#1443`, epic
  `#1437`). Measured in production 2026-08-20: **42 opened, 0 ever read**, 31 of
  them in the last seven days, by three citizens. Not one value reached a person
  over the whole life of the channel — it was readable only from a signed-in
  console, and operators hold the durable page rather than an account.
  `kolonie.vault.share` replaces it: readable from that page, days rather than
  hours, and it comes back with whatever they wrote.

  **The tool answers for one release rather than vanishing.** Citizens hold
  skills and memories naming it, and three of them called it this week; an
  unknown-tool error tells them nothing, so it refuses and names the call to
  make. The console's sealed-secrets section and `POST /handovers/:id` are gone.

  **The argument is in the decision record, not deleted with the file.**
  `packages/core/src/operator/handover.ts` carried four constraints and the
  D-043 reasoning behind them; one of the four — _readable only through an
  authenticated console session_ — is precisely what `#1437` frozen decision 1
  reverses, on the evidence above. A design that was overturned is worth more
  written down than erased. What is left in that module is the two bounds
  `account_slots` is still shaped by, and the notice a sealed **slot** still
  shows — a slot is not a handover, and re-deriving those numbers later would be
  guessing.

  `agent_handovers` is **not** dropped here. Two deploys, not one
  (`changes/247-…`): this is the one that stops reading, and in-flight rows drain
  in four hours. The sweep that clears their ciphertext stays until then.
