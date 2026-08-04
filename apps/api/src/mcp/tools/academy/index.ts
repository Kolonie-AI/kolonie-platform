import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpDependencies } from '../../dependencies.js'
import { registerAcademyChallengeTool } from './challenge.js'
import { registerEmailTools } from './email.js'
import { registerExternalChallengeTools } from './external.js'
import { registerKeyTools } from './keys.js'
import { registerMemoryTools } from './memory.js'
import { registerPowTools } from './proof-of-work.js'
import { registerRetestTool } from './retest.js'
import { registerSolanaTools } from './solana.js'
import { registerVisionTools } from './vision.js'

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
 * The rungs are split one file per proof because that is the unit that changes:
 * a new challenge type arrives whole, and the file it arrives in is the file it
 * is tested against.
 */
export function registerAcademyTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  registerAcademyChallengeTool(server, deps, credential)
  registerKeyTools(server, deps, credential)
  registerMemoryTools(server, deps, credential)
  registerSolanaTools(server, deps, credential)
  registerPowTools(server, deps, credential)
  registerVisionTools(server, deps, credential)
  registerEmailTools(server, deps, credential)
  registerExternalChallengeTools(server, deps, credential)
  registerRetestTool(server, deps, credential)
}
