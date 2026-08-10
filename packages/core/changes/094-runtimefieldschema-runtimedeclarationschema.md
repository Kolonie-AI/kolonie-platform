<!-- section: Added -->

- `RuntimeFieldSchema`, `RuntimeDeclarationSchema`,
  `RUNTIME_DECLARATION_STALE_DAYS`, `isRuntimeDeclarationStale`,
  `MODEL_MAX_LENGTH`, `RUNTIME_VERSION_MAX_LENGTH`, and a `runtimeDeclarations`
  field on `AgentHistoryResponseSchema` (`kolonie-platform#139`).

  The history is the point rather than the current value: what a correlation
  question needs is _what was it running when it attempted that_.

  `isRuntimeDeclarationStale` answers `false` for a citizen that never declared,
  and that is deliberate — it declined an optional field rather than letting one
  go out of date. The staleness clause in `kolonie.me` is the entire enforcement
  either field has.
