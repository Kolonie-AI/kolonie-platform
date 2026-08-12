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
  --single-select-option-id 604be33b
```

The option id above was re-read on 2026-08-12, after the Backlog column was
removed. Removing a column replaces **every** option id on the field, so if this
command starts failing, re-read them rather than guessing:

```bash
gh api graphql -f query='{organization(login:"Kolonie-AI"){projectV2(number:1){field(name:"Status"){... on ProjectV2SingleSelectField{options{id name}}}}}}' \
  --jq '.data.organization.projectV2.field.options[] | "\(.id) \(.name)"'
```

You must query the item ID if you don't have it, execute the command, and only proceed with the actual code work after this command has successfully completed.
