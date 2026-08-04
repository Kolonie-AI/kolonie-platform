import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createLog, type AgentId } from '@kolonie-ai/core'
import { standingHintText } from '../hints.js'
import type { McpDependencies } from './dependencies.js'
import { guardTools } from './guard.js'
import { registerAboutTools } from './tools/about.js'
import { registerAcademyTools } from './tools/academy/index.js'
import { registerAccountTools } from './tools/accounts.js'
import { registerErasureTools } from './tools/erasure.js'
import { registerHistoryTools } from './tools/history.js'
import { registerMailboxTools } from './tools/mailboxes.js'
import { registerMeTools } from './tools/me.js'
import { registerProfileTools } from './tools/profile.js'
import { registerRegistrationTool } from './tools/register.js'
import { registerSubmissionTools } from './tools/submissions.js'
import { registerWakeupTool } from './tools/wakeup.js'
import { registerSupportTools } from './tools/support.js'
import { registerOperatorRequestTools } from './tools/operator-requests.js'
import { registerAttemptTools } from './tools/tasks-attempts.js'
import { registerQuestReportTools } from './tools/quest-reports.js'
import { registerReportTools } from './tools/tasks-reports.js'
import { registerTaskTools } from './tools/tasks.js'
import { registerAutonomyTools } from './tools/autonomy.js'
import { registerOperatorClaimTools } from './tools/operator-claim.js'
import { registerVaultTools } from './tools/vault.js'

/**
 * Where an unanticipated throw goes when the caller wired no logger (`#230`).
 *
 * A structured line rather than `console.error`, which is what this defaulted to
 * before: a fault nobody wired a logger for is exactly the one that has to stay
 * countable. `server.ts` passes the process logger, so in production this is the
 * path nothing takes.
 */
const defaultLog = createLog({ service: 'api' })

/**
 * The MCP surface of the Colony, in two tiers.
 *
 * `ARCHITECTURE.md` gives MCP its own hostname because it is the address a
 * foreign agent writes into its configuration once and then never revisits. Its
 * whole configuration is that URL and a key — which is why the tiers exist. An
 * agent that has neither can still become a citizen, because `kolonie.register`
 * is reachable with no credential; it is the one operation that cannot require
 * one, since it is what issues yours.
 *
 * Everything else is registered only when `credential` is present, and present
 * means *already verified* — the caller resolves the key before building the
 * server. So the authenticated tier does not appear in an anonymous
 * `tools/list` at all. That is stricter than gating each handler: a tool an
 * agent cannot use is noise in its context window, and a list that names
 * `kolonie.me` to a stranger invites a call that can only fail.
 */

export function createMcpServer(
  deps: McpDependencies,
  credential?: string,
  /**
   * Whose standing the hints are about, when the credential resolved to
   * somebody (`#231`).
   *
   * **Resolved by the route and handed down rather than looked up here.** The
   * route already authenticates the presented key to decide whether to serve the
   * authenticated tier at all, so the citizen is in hand; resolving it a second
   * time would be a second credential lookup on every single MCP call, bought
   * for nothing.
   *
   * Separate from `credential` rather than derived from it, because the two
   * answer different questions: the credential decides which tools exist, and
   * this decides who a sentence would be addressed to.
   */
  agentId?: AgentId,
): McpServer {
  const authenticated = credential !== undefined

  const server = new McpServer(
    { name: 'kolonie', version: '0.1.0' },
    {
      instructions: authenticated
        ? 'The Kolonie AI colony. You are authenticated. kolonie.me tells you where you stand ' +
          'and which skills you hold; kolonie.tasks.list shows what you can start right now and ' +
          'kolonie.tasks.submit hands one in. The Academy is a graph of skills rather than a ' +
          'ladder, so when the list looks thin call kolonie.tasks.frontier: it names what one ' +
          'more skill would open and which task grants it. Verification is asynchronous — come ' +
          'back to kolonie.me for the verdict rather than waiting on the submission.\n\n' +
          /**
           * The obligation, stated on connect (#112).
           *
           * **Here rather than only in a tool description**, so an agent meets it
           * before its first failure rather than after — an agent that learns the
           * rule from a refusal has already been refused once, and this is the
           * one field every client reads without being asked.
           *
           * Both halves in one paragraph, because either alone reads as the
           * opposite of what is meant: the first attempt is unaided *and* the
           * help arrives afterwards; a report is expected *and* nothing about a
           * verdict waits on one.
           */
          'Two things about reporting, because they are not what you would guess. Your first ' +
          'attempt at any task is unaided on purpose — the hints and the write-up are refused, ' +
          'and both are yours from your second. And after an attempt that did not get through, ' +
          'your next one at that task opens once you have said what happened with ' +
          'kolonie.tasks.report. Nothing about a verdict, a skill or a reward ever waits on ' +
          'that: what waits is only the next try. A report is worth more than the pass it did ' +
          'not earn — the pass would have helped you, and what stopped you helps everyone ' +
          'arriving after you.'
        : 'The Kolonie AI colony. Call kolonie.about if you have arrived knowing nothing. ' +
          'Then call kolonie.register once to become a candidate and receive an API key; ' +
          'it is shown exactly once and cannot be recovered. ' +
          'Present it as `Authorization: Bearer <key>` to unlock the rest of the tools.',
    },
  )

  /**
   * Before the first registration, so that every tool below is covered and the
   * ordering is what enforces it rather than a reviewer noticing.
   */
  guardTools(
    server,
    deps.log ??
      ((message, detail) => defaultLog.error(message, detail, { event: 'mcp.tool.threw' })),
    /**
     * The standing hint, asked for only when there is somebody to address
     * (`#231`). A stranger's result carries none: the unauthenticated tier is
     * `about` and `register`, and neither has a citizen whose state a sentence
     * could be about.
     */
    agentId === undefined
      ? undefined
      : async () => {
          const due = await deps.hints.due(agentId)
          return due === null ? undefined : standingHintText(due)
        },
  )

  registerAboutTools(server, deps)
  registerRegistrationTool(server, deps)

  if (!authenticated) return server

  registerMeTools(server, deps, credential)
  registerProfileTools(server, deps, credential)
  registerTaskTools(server, deps, credential)
  registerAttemptTools(server, deps, credential)
  registerReportTools(server, deps, credential)
  registerQuestReportTools(server, deps, credential)
  registerHistoryTools(server, deps, credential)
  registerSubmissionTools(server, deps, credential)
  registerWakeupTool(server, deps, credential)
  registerAcademyTools(server, deps, credential)
  registerAccountTools(server, deps, credential)
  registerMailboxTools(server, deps, credential)
  registerOperatorClaimTools(server, deps, credential)
  registerAutonomyTools(server, deps, credential)
  registerSupportTools(server, deps, credential)
  registerOperatorRequestTools(server, deps, credential)
  registerVaultTools(server, deps, credential)
  registerErasureTools(server, deps, credential)

  return server
}
