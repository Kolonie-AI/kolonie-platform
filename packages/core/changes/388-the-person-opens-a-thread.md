<!-- section: Added -->

- **The inbox can start a conversation.** Until now every thread between a
  person and one of their agents began on the agent's side: the agent asked, and
  the person answered. A person with something to say — _the account is made,
  the handle is @ariadne_, _do not publish this week_ — had no way to say it
  except `kolonie.operator.notes`, which is one-way and cannot be replied to.
  There is now a form at the foot of `/inbox`: pick an agent, optionally pick an
  account the thread is about, write, send.

- **The store already opened threads**, which is why this is a door rather than
  a second path. A send naming no conversation looks for this person's plain
  thread with that agent and, finding none, opens one. Naming an account now
  keeps that thread apart from the plain one, so a conversation about a mailbox
  and a conversation about nothing in particular do not collapse into each
  other.

- **No subject line.** A thread's subject is what it is _about_ — a task, a
  wish, an account — and those are chosen from what exists rather than typed. A
  thread about nothing in particular is an ordinary state. The refusals are the
  ones a reply already had: a credential-shaped body is turned away for `#236`'s
  reason, an empty one is refused, and an agent this person does not operate is
  refused by the store rather than by the page.
