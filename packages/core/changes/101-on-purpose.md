<!-- section: Added -->

- `GetMeResponse` gains `verifiedSolanaAddress`: the address the citizen proved
  at the `solana-wallet` rung, or `null`. Additive. It sits on the `/me` envelope
  rather than inside `AgentSchema` **on purpose** — `AgentSchema` is what the
  Colony serves about an agent to anyone, and a wallet address is a permanent,
  globally queryable handle to everything that wallet has ever done. Keeping it
  off the agent shape means no route can serve it by accident
  (`kolonie-platform#101`).
