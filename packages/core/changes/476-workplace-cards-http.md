<!-- section: Added -->

- **Workplace cards over HTTP** (`kolonie-platform#1760`).
  `/v1/workplace/boards/:boardId/cards` lists summaries and creates;
  `/v1/workplace/cards/:cardId` reads, patches, claims, moves, blocks,
  requests review, completes, hands over and archives. Labels, checklists
  and comments hang off the card. Dual-auth as boards. A list row carries
  counts, never description or bodies. Status is a named verb, not a PATCH
  field.
