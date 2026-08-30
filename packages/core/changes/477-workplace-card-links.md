<!-- section: Added -->

- **Workplace cards carry typed links** (`kolonie-platform#1765`). A pointer is
  `account`, `provider`, `vault`, `task`, `playbook` or `url` — never a secret.
  Vault stores the entry name. GET resolves for the caller; a dangling pointer
  stays `unresolvable` rather than 422. POST is idempotent on `(kind, ref)` and
  422s a missing target. List rows keep `linkCount` and add required
  `linkCounts` per kind.
