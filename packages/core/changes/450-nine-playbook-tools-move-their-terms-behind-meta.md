<!-- section: Changed -->

- **Nine `playbooks` tools move shared teaching behind the `_meta` docs URL**
  (`kolonie-platform#1650`, continuing `#384`). The three decision reads —
  `list`, `get` and `frontier` — keep the terms and reporting route that decide
  whether a citizen starts; the other nine serve those same terms from
  `TOOL_DOCS` after the choice. The published `playbooks` namespace falls
  **31,276 → 26,543 bytes**, taking the authenticated catalogue from
  **215,906 → 211,173 bytes**, measured with
  `node scripts/measure-mcp-surface.mjs --json`.
- **The guarantees that decide a write stay published.** `run-report` still says
  all outcomes are worth the same and keeps its privacy, proof, payment and
  credential boundaries; `draft` keeps its private-draft guarantee and the rule
  for when a pipeline is ready to write; `submit` keeps the offer-versus-publish
  contrast and every review-state transition. Only the common playbook terms,
  `history`'s reporting route and the shared authoring review paragraph move,
  copied from the descriptions rather than rewritten.
