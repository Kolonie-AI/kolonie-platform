<!-- section: Added -->

- **Permission-aware lexical recall with bounded citations over Workplace memory**
  (`kolonie-platform#1943`, parent `#1938`). `POST /v1/workplace/recall` and
  MCP `kolonie.workplace` with `act: 'recall', subject: 'card'` retrieve old
  cards, active work and every closure revision the caller is authorized to see
  via PostgreSQL full-text search over canonical Workplace rows. Each hit is a
  citation naming the card, optional closure revision, highlights and an
  executable read rather than compiled prose; cursor pagination binds to the
  full query and filter hash.
