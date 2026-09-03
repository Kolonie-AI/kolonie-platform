<!-- section: Changed -->

- **Breaking:** Skill notes now expose character-budget metadata and a stable version, report whether writes grew or shrank the body, and accept an optional `expectedVersion` for atomic compare-and-replace. Existing writes without it remain unconditional. (#1822)
