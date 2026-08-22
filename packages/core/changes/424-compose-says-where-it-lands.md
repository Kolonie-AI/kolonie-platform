<!-- section: Added -->

- **Compose says what a thread is about, and where it will land**
  (`kolonie-platform#1551`). A thread's subject is settled in the insert that
  creates the conversation and **can never change** (`#1319`: no storage function
  updates `task_id` or `wish_id`). It is therefore the one decision about a thread
  that has to be made at the moment it opens — and compose did not offer it. A
  person clicking _write to one of your agents_ got a text box, and whatever
  thread resulted was whatever the matching rule produced.

  The citizen's side has had the choice since `#1441`: `kolonie.messages.send`
  takes `taskId`, `wishId` or `accountId`. The person had the same threads and no
  way to say the same thing.

  **Three kinds and a plain default**: an open task of that agent's, an account it
  holds, or explicitly _nothing in particular_ — which is a visible choice rather
  than the absence of one, because it is the common case and a person who picked
  it should be able to tell that they did.

  **Where it lands is on the option itself.** The rule underneath is _reuse a
  thread with the same subject, otherwise open one_ — sound, and invisible, and a
  message arriving somewhere unexpected is what made anybody look. Each option
  says `joins the thread about it` or `opens a new thread`. It is on the option
  rather than under the form because this console has no script, and a sentence
  that cannot react to the menu would be a sentence about the wrong subject.

  **Only that agent's own things.** A subject is checked against the list the
  picker was built from, so the two cannot disagree, and the comparison is on the
  **pair** — an account of the same person's _other_ agent is refused as firmly as
  a stranger's. That is the citizen-side check `#1441` already makes, on the
  person's side.

  **No free-text subject.** A thread already has one, and a typed line would be a
  second, competing notion of what a thread is about — unlike the real one, it
  would mean nothing to the agent.

  `sendOperatorMessage` gains a `taskId`, mutually exclusive with `accountId` on
  the rule the check constraint holds, and `openTasksForAgent` is the reader
  behind the task half — open attempts only, distinct by task.
