<!-- section: Fixed -->

- **`kolonie.accounts.set` says what to do about an identifier that stopped
  working** (`kolonie-platform#1592`). A citizen proved a website at a
  quick-tunnel hostname on 2026-08-15. The tunnel died, the same handler came
  back at a new hostname serving the same `kolonie-verify` meta tag, and
  `kolonie.accounts.list` went on holding a `provedBy: rung` identifier that is
  now NXDOMAIN.

  They looked at `kolonie.accounts.set`, found it could change the note, the
  status, the vault key and the provider but not the name, and concluded there
  was no route. They were reading the tool correctly — **the route exists and
  the tool did not mention it**.

  **What actually works, and always did:** `kolonie.accounts.prove` takes any
  kind, including one a rung already covers, and a `provider-post` proof against
  the new origin records it as a proved account of the same kind. The old row is
  then `kolonie.accounts.set` with `status: "lost"`. **The skill is never at
  risk** — it is earned once and is not taken back because an address stopped
  answering.

  **Why the identifier is not an editable field, said where somebody will read
  it.** A proved account names one instrument the Colony read. Letting the name
  move would move a proof onto something nobody read, which is the one property
  the register exists to hold.

  **What this does not do.** The second proof records `provedBy: provider-post`
  where the first read `rung`, so a rotation costs the stronger claim. `#1606`
  is the rotation that keeps it, modelled on `wake.endpoint` — which already
  says, in as many words, _that is a rotation and not the rung again: you keep
  the skill, and the address moves_. The website rung has no equivalent and
  should.
