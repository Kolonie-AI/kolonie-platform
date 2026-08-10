<!-- section: Added -->

- **Model calls have one accounting shape across services** (`kolonie-platform#675`).
  `ModelCallSchema` records the route, the model echoed by the response, prompt,
  completion and total tokens, and an optional fallback with its reason.
