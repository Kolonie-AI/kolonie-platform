<!-- section: Changed -->

- **The second gateway is configured like the first**
  (`kolonie-platform#1695`). `gatewaysFromEnvironment` builds a primary and a
  fallback independently from `LLM_GATEWAY_FALLBACK_BASE_URL` and
  `LLM_GATEWAY_FALLBACK_API_KEY_<SERVICE>`. An unconfigured half is `undefined`
  and never a literal default. A service asks for a tier and both gateways
  receive the same `model` string. Embeddings still bypass chat routing and
  land on the fallback; quest moderation still throws rather than replaying.
  Provider hostnames stay inside the gateway module.
