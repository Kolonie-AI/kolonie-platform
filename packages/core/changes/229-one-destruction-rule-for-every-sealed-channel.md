<!-- section: Fixed -->

- **One destruction rule now covers all three sealed channels, and the slot
  channel can carry out its own** (`kolonie-platform#955`). Three places in the
  Colony hold a secret briefly and then stop holding it: the recipe handover
  (agent → operator), `kolonie.operator.drop.*` (operator → agent), and the
  account slot that will one day be both. Measuring them found the rule was one
  in name only.

  **The slot could not destroy anything at all.**
  `account_slots_filled_together` admitted a slot that was unfilled or filled and
  holding, and nothing else — so nulling the value while `filled_by` and
  `filled_at` stood was a row Postgres refused. That is exactly the state
  `destroyed_at` was added to record, and all three destroyers wrote it: the
  operator's last read, closing the episode, and the sweep. The console would
  have thrown on the third read of the first secret any agent ever sealed for its
  operator. Nothing reported it because no test had ever filled a _secret_ slot
  and then destroyed one, and production has carried no slot secret at all. The
  constraint now admits the destroyed state, and each of the three destroyers has
  a test of its own.

  **A drop was never on the timer it was promised.**
  `kolonie.operator.drop.open` says the value "is gone on the timer whether or
  not anybody read it", and nothing ran on that timer — the only thing that
  cleared a drop's ciphertext was an agent coming back to take it. So a drop the
  operator answered and the agent never returned for kept its value for ever:
  two credentials sealed on 2026-08-05 were still holding one on 2026-08-15,
  seven days past their expiry. `destroyExpiredSlots`, written with the slot
  channel, was called by nothing whatsoever.

  Both now run on the verifier-runner tick that already swept handovers.
  **The sweep is the single answer to _is this still live_**, deliberately not
  repeated as a `where` clause in the read: two answers disagree the first time
  the sweep is late, and `takeDrop` already reads an absent value as nothing. The
  loop now asserts that every housekeeping sweep was called — a sweep is the one
  kind of work whose absence looks exactly like its success.
