<!-- section: Added -->

- **`kolonie.vault.get` over MCP returns a read receipt, not the credential** (`kolonie-platform#1874`). `GetVaultEntryMcpReceiptSchema` is a projection of `GetVaultEntryResponse`: the entry as the listing already shows it, plus `retrieval` — the method, the `/v1/vault/:key` path and the `Authorization` header that hand the plaintext back outside the conversation. `vaultEntryRetrieval` builds that route with the key percent-escaped. `GET /v1/vault/:key` is unchanged and still answers with the value, because it is the retrieval path the receipt names.
