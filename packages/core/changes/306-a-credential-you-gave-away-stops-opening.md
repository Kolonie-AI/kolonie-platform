<!-- section: Changed -->

- A vault entry whose account you gave away keeps its bytes and stops opening
  (`#1214`). Nothing deletes it: a vault another citizen's act can empty is not
  the vault D-043 describes. `kolonie.vault.get` refuses it with a `conflict`
  whose `details.reason` is `credential_transferred` — a different fact from an
  entry sealed with a key you no longer present, and the two are told apart
  rather than sharing a message. The entry is still listed, still yours to
  describe and to delete, and writing a new value under the name makes it live
  again. The mark is set only when nothing else of yours still names that entry:
  one key that opens several accounts is what `kolonie.accounts.give` already
  pauses on, and marking anyway would strip a credential from accounts nobody
  gave away.
