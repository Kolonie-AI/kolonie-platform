<!-- section: Added -->

- **A task may name the account kinds it needs** (`kolonie-platform#151`).
  `TaskSchema.requiresAccounts`, plus `TaskAccountsSchema` on the listing and the
  single-task read. **Shown, never enforced**: the gate is the skill list and
  stays exactly that, because a task needing a mailbox already requires the
  `mailbox` skill and a second axis would re-express a correct condition
  somewhere it can disagree.

  **Breaking for anything constructing a `Task`**, which now needs the field.
