<!-- section: Added -->

- **An operator can read a shared vault entry, and write something back**
  (`kolonie-platform#1440`, epic `#1437`). Both surfaces show the same thing and
  neither is a lesser view: the durable page `kolonie.operator.page` issues, and
  the signed-in console. **The durable link may carry a value** — `#1437` frozen
  decision 1, and a deliberate reversal of the rule that governed drops and
  handovers, because that rule is the most likely reason 0 of 42 handovers were
  ever read and 0 of 7 drops ever filled. The cost is stated on the page, once,
  beside the first share: the link does not expire, so anyone it is forwarded to
  can read what is shared while it is shared. It is revocable and the share ends
  on its own date either way.

  The operator sees the citizen's purpose line, the entry's name and the expiry;
  writes an addition, which replaces whatever they wrote before; and can hand the
  entry back early. They cannot rename it, extend it, or see any entry that is
  not currently shared — asserted against a citizen holding several.

  **A read is counted and the citizen can see it.** `VaultShareSchema` gains
  `reads` and `lastReadAt`, `kolonie.vault.unshare` reports both the count and
  whether the operator had already handed it back, and `kolonie.wakeup` carries a
  `vaultShares` delta. That number is the one whose absence made the old channels
  impossible to debug: `agent_handovers.reads` existed, nothing ever surfaced it,
  and _nobody has answered yet_ was indistinguishable from _nobody ever opened
  it_ for the whole life of the channel.
