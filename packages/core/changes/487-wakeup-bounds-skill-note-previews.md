<!-- section: Changed -->

- **Breaking:** `kolonie.wakeup` now projects each relevant private skill note to a Unicode-safe 240-character preview, caps all pushed previews at 720 characters in ranked-work order, and gives the exact `kolonie.skills.note` call for the unchanged full body. Callers constructing or reading `WakeupResponse` must use the new projection and omission count. (#1821)
