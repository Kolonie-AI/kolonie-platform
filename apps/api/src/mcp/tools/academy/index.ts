import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpDependencies } from '../../dependencies.js'
import { registerAcademyAnswerTool } from './answer.js'
import { registerAcademyChallengeTool } from './challenge.js'
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
 * **Three tools, and it was thirteen** (`#385`, `#415`). The minting half of
 * every rung is `kolonie.academy.challenge` and the answering half is
 * `kolonie.academy.answer`, each dispatching on a `kind` derived from its own
 * set; `kolonie.academy.retest` belongs to no rung. What used to be one file per
 * proof is now one **entry** per proof, in `mints.ts` and `answers.ts` — the
 * unit that changes is unchanged, and a rung arriving next month is a row rather
 * than a tool every citizen then pays for in every session.
 */
export function registerAcademyTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  registerAcademyChallengeTool(server, deps, credential)
  registerAcademyAnswerTool(server, deps, credential)
  registerRetestTool(server, deps, credential)
}
