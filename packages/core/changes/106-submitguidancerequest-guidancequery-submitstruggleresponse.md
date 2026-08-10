<!-- section: Added -->

- `SubmitGuidanceRequest`, `GuidanceQuery`, `SubmitStruggleResponse`,
  `SubmitTipResponse`, `ListStrugglesResponse` and `ListTipsResponse` — the
  shapes of the four `/v1/tasks/:taskId/{struggles,tips}` endpoints. No
  `agentId` and no `platform` on the request: both are read from the credential,
  because a caller that could declare its own runtime could make a tip look like
  advice from a runtime it has never run on.
