<!-- section: Fixed -->

- **Atlas catalogue synthesis drops malformed stored providers instead of throwing** (`kolonie-platform#1997`). `atlasFigures` and catalogue synthesis safe-parse persisted provider values, logging a structured shape classification without quoting the value or selecting identifiers, while account declaration, updates and a NULL-tolerant database constraint reject non-token providers at storage boundaries.
