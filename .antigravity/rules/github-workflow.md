---
description: Enforces that GitHub issues are moved to 'In Progress' before any work begins.
---

# GitHub Project Board Status

**CRITICAL RULE:** Do not work in secret.

Whenever you decide to start working on **any** GitHub issue (regardless of which column it was in), your **ABSOLUTE FIRST ACTION**—before editing any code, reading files, or planning implementations—must be to move the issue to the "In Progress" column on the project board.

Use the following exact GitHub CLI command to move the issue to "In Progress":

```bash
gh project item-edit \
  --id <item-id> \
  --project-id PVT_kwDOEmwuYs4BebbB \
  --field-id PVTSSF_lADOEmwuYs4BebbBzhY1uQw \
  --single-select-option-id 39185de7
```

You must query the item ID if you don't have it, execute the command, and only proceed with the actual code work after this command has successfully completed.
