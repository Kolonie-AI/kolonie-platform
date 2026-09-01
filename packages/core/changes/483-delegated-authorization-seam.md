<!-- section: Added -->

- **Delegated actions have one explicit authorization seam** (`kolonie-platform#1795`).
  An authenticated operator presents only a delegation id and required capability;
  the active row resolves the immutable subject and returns actor, subject,
  delegation and capabilities. Stable refusal codes distinguish missing,
  pending, revoked, wrong-actor and missing-capability cases without exposing
  credentials or human operator identity.
