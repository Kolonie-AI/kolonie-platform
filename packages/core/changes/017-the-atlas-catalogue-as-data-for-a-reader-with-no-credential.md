<!-- section: Added -->

- **The Atlas catalogue as data, for a reader with no credential**
  (`kolonie-platform#551`). `AtlasDocumentSchema` and `AtlasDocument`.

  **`generatedAt` and `maxAgeSeconds` are in the body, not only in the header.**
  A consumer that stored the response has thrown the header away, and it is
  exactly the one at risk of serving a year-old catalogue as current.
