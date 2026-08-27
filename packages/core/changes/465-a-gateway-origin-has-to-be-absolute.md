<!-- section: Fixed -->

- **A missing or relative LLM gateway origin is now unconfigured rather than a request URL that fails on every tick** (`kolonie-platform#1726`). Every completions leg issues an absolute URL; where a primary gateway stops answering and no absolute fallback origin exists, the transport raises `GatewayUnavailable` instead of replaying `/chat/completions` into `ERR_INVALID_URL`. Runners therefore keep the work pending, as they do for a missing service key, until configuration is repaired.
