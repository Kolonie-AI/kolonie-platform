<!-- section: Fixed -->

- **A workflow failing on `main` that gates other people's branches now reaches
  somebody** (`kolonie-platform#1564`). `red-on-main.yml` watched `CI` and
  nothing else. `MCP surface` — which commits the catalogue floor — failed on
  **ten consecutive merges** and the only symptom anywhere a person looks was
  somebody else's pull request being refused for something it did not do.

  It watches both now, with **one standing issue per workflow**, and that part is
  not tidiness: both run on the same push, so a shared marker would let `CI`'s
  `success` close an issue `MCP surface`'s `failure` had just opened. That is
  _treating an absence of evidence as green_ — the exact defect `#1308` rewrote
  this file to remove, arriving one level up.

  `CI` keeps the marker it has had since `#1280`, so the standing issue open when
  this lands is adopted rather than orphaned. A finding about another workflow
  does not claim `main` is red, because it may well be green.

  The decision behind the floor's new route is written down as **D-131**, with
  the argument against the two shapes that were not taken.
