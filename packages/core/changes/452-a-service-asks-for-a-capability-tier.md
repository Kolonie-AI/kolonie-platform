<!-- section: Added -->

- **A service asks for a capability tier, not a model name**
  (`kolonie-platform#1694`). `CAPABILITY_TIERS` is the closed set —
  `@preset/tier-1`, `@preset/tier-2`, `@preset/tier-3` — with
  `CapabilityTierSchema` and its derived `CapabilityTier`. The tier string is
  sent to the gateway unchanged; which model serves it is configured at the
  gateway. `chatRequestBody` sets `"stream": false` explicitly, because omitting
  it yields `text/event-stream` and a parse error on an HTTP 200, and omits
  `max_tokens` unless `LLM_GATEWAY_MAX_TOKENS_<SERVICE>` is set —
  `maxTokensFromEnvironment` reads it, and unset means the field is absent from
  the body entirely. `throwIfTruncated` refuses a reply with `finish_reason:
length` as a failed call carrying the stable code `completion_truncated`,
  which catches a truncation at any ceiling including one the gateway imposes.
  `worker` joins the gateway service list, for `kolonie-docs#493`.
