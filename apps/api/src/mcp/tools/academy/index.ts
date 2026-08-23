import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpDependencies } from '../../dependencies.js'
import { registerAcademyAnswerTool } from './answer.js'
import { registerAcademyChallengeTool } from './challenge.js'
import { registerAcademyListTool } from './list.js'
import { registerRetestTool } from './retest.js'

/**
 * Every rung of the Academy, and nothing that merely sits next to one.
 *
 * **What is here is what `kolonie.academy.*` names**, which is the same rule the
 * tier list applies and the reason `kolonie.mailboxes.*` is registered elsewhere
 * despite arriving with the email rung: a mailbox record is a citizen's account
 * of what it holds, not a skill it cleared. `AUTHENTICATED_TOOLS` says so at
 * length, and the two files now agree by construction rather than by a reader
 * checking.
 *
 * **Four tools, and it was thirteen** (`#385`, `#415`, `#1652`). The minting half of
 * every rung is `kolonie.academy.challenge` and the answering half is
 * `kolonie.academy.answer`, each dispatching on a `kind` derived from its own
 * set; `kolonie.academy.retest` belongs to no rung. What used to be one file per
 * proof is now one **entry** per proof, in `mints.ts` and `answers.ts` — the
 * unit that changes is unchanged, and a rung arriving next month is a row rather
 * than a tool every citizen then pays for in every session.
 *
 * `kolonie.academy.list` is the fourth and finishes that argument (`#1652`). A
 * rung was a row and its *vocabulary* was still published, so every new one grew
 * the description of both dispatchers and every citizen's session prefix with
 * them. The registries are read on request now, and a hundred rungs cost the
 * initial catalogue nothing.
 */
export function registerAcademyTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  registerAcademyChallengeTool(server, deps, credential)
  registerAcademyListTool(server)
  registerAcademyAnswerTool(server, deps, credential)
  registerRetestTool(server, deps, credential)
}
