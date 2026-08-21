import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpDependencies } from '../dependencies.js'
import { registerAccountAtlasTools } from './accounts-atlas.js'
import { registerAccountOperatorTools } from './accounts-operator.js'
import { registerAccountProofTools } from './accounts-proofs.js'
import { registerAccountProviderTools } from './accounts-providers.js'
import { registerAccountRegisterTools } from './accounts-register.js'
import { registerAccountTransferTools } from './accounts-transfer.js'
import { registerAccountWalkTools } from './accounts-walks.js'

/**
 * The nineteen `kolonie.accounts.*` tools, registered from seven modules
 * (`#1500`).
 *
 * ## What this file used to be
 *
 * 3,625 lines and nineteen tools, against six neighbours in this directory
 * averaging 700 — three times its largest one, and the second-highest churn of
 * any large file in the repository at 104 changes in thirty days. It is now a
 * list of calls, and each subject is a file the size the directory already uses.
 *
 * ## It was a move, and that is the only reason it was reviewable
 *
 * Every tool body is byte-identical to what was here. **No shared module had to
 * be established first**, which `#1500` named as most of the work and as the
 * thing most likely to turn a move into a rewrite: the eight module-level
 * helpers are each used by exactly one subject, so each travelled with its own
 * tools. Four went to `accounts-atlas.ts` and four to `accounts-walks.ts`.
 *
 * The tool descriptions in `../text/` did not move either. That tree is already
 * scoped by subject — `accounts`, `walk-own-prose`, `walk-prose-refusal`,
 * `walk-reach` — so each module imports the ones it needs and the question of
 * whether text travels with its tool answered itself.
 *
 * ## What is guaranteed across the split
 *
 * Every tool keeps its name and its path, and the served catalogue is
 * byte-identical: `catalogue-structure.json` and the fingerprint beside it did
 * not move, which is the check that would have caught a body rewritten in the
 * same change (`#1379`).
 *
 * ## The order below is the order they were in
 *
 * Deliberately, so that a reader comparing this against the old file reads the
 * tools in the sequence they were written in. `tools/list` orders by
 * registration, so this is also what a citizen sees.
 */
export function registerAccountTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  registerAccountRegisterTools(server, deps, credential)
  registerAccountTransferTools(server, deps, credential)
  registerAccountProviderTools(server, deps, credential)
  registerAccountProofTools(server, deps, credential)
  registerAccountAtlasTools(server, deps, credential)
  registerAccountOperatorTools(server, deps, credential)
  registerAccountWalkTools(server, deps, credential)
}
