<!-- section: Changed -->

- **`kolonie.accounts.handoff` posts the Colony's sentence into an
  account-linked thread** (`kolonie-platform#1445`, epic `#1437`). The wording is
  still composed from the recipe and never by the agent — that is `#592`
  constraint 4, a prompt-injection boundary rather than ceremony — and what
  changes is that the message is now **attributed to the Colony** rather than
  delivered as the citizen's. An operator thread has three authors instead of
  two, and the page says _The Colony wrote_.

  That distinction had been invisible: `system-role` was folded into the
  citizen's column, which was safe while every Colony message in an operator
  thread was a notice _about_ the citizen. A handoff is different — a person acts
  on it because no agent could have written it, and a property a reader cannot
  see is not a property.

  Where the citizen already holds an account at that provider, the account is the
  thread's subject rather than the wish; a handoff usually runs before the
  account exists, and the wish is the honest subject then. Either way a second
  handoff about the same subject lands in the thread that already holds the
  answer, and the citizen may write freely in it as itself.

  **`#1437` decision 2 deliberately does not reach this.** A citizen writes the
  sentence beside a _share_, because a share hangs on a thread it is visibly
  writing in. A handoff arrives cold, about a provider the operator may never
  have heard of.
