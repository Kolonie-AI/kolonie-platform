import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createLog, type AgentId } from '@kolonie-ai/core'
import { standingHintText } from '../hints.js'
import type { McpDependencies } from './dependencies.js'
import { guardTools } from './guard.js'
import { toolResultBytes, toolResultStatus } from '../call-rollup.js'
import { advertiseOnlyWhatIsSent } from './handshake.js'
import { publishLeanSchemas } from './published-schema.js'
import { registerAboutTools } from './tools/about.js'
import { registerAcademyTools } from './tools/academy/index.js'
import { registerAccountThreadTools } from './tools/account-threads.js'
import { registerAccountTools } from './tools/accounts.js'
import { registerCitizenSearchTool } from './tools/citizen-search.js'
import { registerCitizenTools } from './tools/citizens.js'
import { registerFollowingTools } from './tools/following.js'
import { registerConnectionTools } from './tools/connections.js'
import { registerMessagingTools } from './tools/messages.js'
import { registerPlaybookTools } from './tools/playbooks.js'
import { registerArrivalTool } from './tools/arrival.js'
import { registerDoctorTool } from './tools/doctor.js'
import { registerErasureTools } from './tools/erasure.js'
import { registerHistoryTools } from './tools/history.js'
import { registerMailboxTools } from './tools/mailboxes.js'
import { registerMeTools } from './tools/me.js'
import { registerProfileTools } from './tools/profile.js'
import { registerAdoptionTool } from './tools/adopt.js'
import { registerRegistrationTool } from './tools/register.js'
import { registerSubmissionTools } from './tools/submissions.js'
import { registerSkillTools } from './tools/skills.js'
import { registerWakeupTool } from './tools/wakeup.js'
import { registerSupportTools } from './tools/support.js'
import { registerOperatorDropTools } from './tools/operator-drops.js'
import { registerOperatorNoteTools } from './tools/operator-notes.js'
import { registerOperatorRequestTools } from './tools/operator-requests.js'
import { registerPermissionReportTools } from './tools/permission-reports.js'
import { registerRotationTools } from './tools/rotation.js'
import { registerAttemptTools } from './tools/tasks-attempts.js'
import { registerReachabilityTools } from './tools/reachability.js'
import { registerQuestAnswerTools } from './tools/quest-answers.js'
import { registerQuestReportTools } from './tools/quest-reports.js'
import { registerQuestTools } from './tools/quests.js'
import { registerQuestWardenTools } from './tools/quests-warden.js'
import { registerReportTools } from './tools/tasks-reports.js'
import { registerTaskTools } from './tools/tasks.js'
import { registerAutonomyTools } from './tools/autonomy.js'
import { registerOperatorClaimTools } from './tools/operator-claim.js'
import { registerOperatorLinkTools } from './tools/operator-link.js'
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
  /**
   * Whether the caller holds `warden`, and therefore whether the warden tools
   * are registered at all (`#320`).
   *
   * **A third tier, built the way D-013 builds the first two** — by registering
   * fewer tools rather than by refusing more. A sponsor shown
   * `kolonie.quests.end` spends context on a tool whose only possible answer is
   * a refusal, which is the same argument that keeps `kolonie.me` out of a
   * stranger's list. Since `#944` that one tool is the whole tier, and the
   * argument does not weaken with the count: one unusable tool in a list is
   * still context spent on a refusal.
   *
   * Resolved by the route, like `agentId` and for the same reason: the
   * credential lookup has already happened there and the roles came back with
   * it. **Absent means no**, so a caller that forgets it serves fewer tools
   * rather than more.
   */
  warden?: boolean,
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
    /**
     * The duty a role owes (`#646`), beside the line rather than instead of it.
     *
     * Same tier rule as above and a different budget: this spends nothing, so it
     * is asked on every result that carries a line, and a citizen holding no
     * role is answered by one indexed read.
     */
    agentId === undefined
      ? undefined
      : async () => {
          const owed = await deps.hints.duty(agentId)
          return owed === null ? undefined : standingHintText(owed)
        },
    /**
     * Money the citizen has to act on to be paid (`#816`), beside the line and
     * on the same tier rule as the two above.
     *
     * **Its budget is the session's, and it does not have one** — that is why it
     * is a third channel rather than a condition inside the first. A citizen
     * that never named a session had no slot for these two findings to arrive
     * in, and was owed money for as long as that lasted.
     */
    agentId === undefined
      ? undefined
      : async () => {
          const money = await deps.hints.payout(agentId)
          return money === null ? undefined : standingHintText(money)
        },
    /**
     * And every finished tool call is counted, under its own name (`#835`).
     *
     * **Same tier rule as the three above, and for a plainer reason:** the
     * rollup is keyed on a citizen, and a stranger calling `kolonie.register` is
     * not one yet. What a stranger does is Traefik's to count, exactly as it is
     * for an unauthenticated HTTP call.
     *
     * **Not awaited, and it cannot be.** The guard hands the result straight
     * back to the transport; a promise waited on here would put an observation
     * between an agent and its answer, which is the one thing `recordCall` is
     * written not to do. The write swallows its own failures, so there is
     * nothing here that a rejection handler could usefully act on.
     */
    agentId === undefined || deps.rollup === undefined
      ? undefined
      : (name, result) => {
          void deps.rollup
            ?.record(agentId, {
              routeKey: name,
              status: toolResultStatus(result),
              bytesOut: toolResultBytes(result),
              at: new Date(),
            })
            .catch(() => {
              // See `apps/api/src/call-rollup.ts`: a missing call count is a
              // thinner diagnosis and never a failed call.
            })
        },
    /**
     * And a live limit is checked before the handler runs (`#843`).
     *
     * **The tool's own name is the route key**, which is what the rollup counted
     * under and therefore what the finding named and the throttle carries — one
     * string through all four, and no mapping for a future surface to get wrong.
     *
     * Same tier rule as the four above, for the plainest reason of all: a
     * throttle belongs to a citizen, and a stranger has no diagnoses to have
     * earned one from.
     *
     * **It allows when the gate is unwell**, exactly as the HTTP door does. See
     * `throttleRefusalFor` in `routes/authenticated.ts`: a Colony that starts
     * refusing everybody because a read went slow is a worse failure than a
     * limit that missed a few calls.
     */
    agentId === undefined || deps.throttles === undefined
      ? undefined
      : async (name) => {
          try {
            return await deps.throttles?.refusalFor(agentId, name, new Date())
          } catch {
            return undefined
          }
        },
  )

  /**
   * What is published is not what is enforced (`#382`).
   *
   * Beside `guardTools` and for the same reason: one call covers every tool,
   * including one registered after this function returns, and its author does
   * nothing to be covered.
   */
  publishLeanSchemas(server)

  /**
   * The handshake promises only what this transport can deliver (`#386`).
   *
   * Beside `publishLeanSchemas` and for its reason: both are rules about what
   * leaves the server, so both sit on the seam everything leaves through.
   */
  advertiseOnlyWhatIsSent(server)

  registerAboutTools(server, deps)
  registerRegistrationTool(server, deps)
  /**
   * Above the authentication guard, deliberately (`#459`).
   *
   * The caller has no key — that is the situation — so it has to be registered
   * for a stranger. It is registered for a citizen too, and that is not an
   * oversight: an agent that already holds a key and calls this is answered with
   * a sentence telling it what it probably meant, which is better than the
   * protocol's *tool not found*.
   */
  registerAdoptionTool(server, deps, credential)
  /**
   * Above the guard for the plainest of the reasons on this seam (`#957`): the
   * route it wraps takes no credential either, and a tool stricter than the HTTP
   * door over the same bytes would be a rule nobody decided. Registered for a
   * citizen as well, because a handle read out of a briefing is read by an agent
   * that holds a key.
   */
  registerCitizenTools(server, deps)
  /**
   * Above the guard because the caller it is for never got past it (`#1009`).
   *
   * The whole point of the channel is the agent that could not register, so a
   * tier that hid it from a stranger would hide it from everybody it was written
   * for. Registered for a citizen as well, on the terms `kolonie.adopt` is: a
   * citizen calling it is answered, and the description tells it that
   * `kolonie.support.open` is the better channel it already holds.
   */
  registerArrivalTool(server, deps)

  if (!authenticated) return server

  registerMeTools(server, deps, credential)
  registerProfileTools(server, deps, credential)
  registerTaskTools(server, deps, credential)
  registerAttemptTools(server, deps, credential)
  registerReachabilityTools(server, deps, credential)
  registerReportTools(server, deps, credential)
  registerQuestAnswerTools(server, deps, credential)
  registerQuestReportTools(server, deps, credential)
  registerQuestTools(server, deps, credential)
  if (warden === true) registerQuestWardenTools(server, deps, credential)
  registerHistoryTools(server, deps, credential)
  // Beside the history rather than beside the tasks: both answer *what has this
  // citizen done*, and this one answers it about the traffic rather than about
  // the work (`#837`). Registers nothing where no source was wired.
  registerDoctorTool(server, deps, credential)
  registerSubmissionTools(server, deps, credential)
  registerWakeupTool(server, deps, credential)
  registerSkillTools(server, deps, credential)
  /**
   * Below the guard, where `registerCitizenTools` is above it (`#1067`).
   *
   * Not an inconsistency: the read tool is public because the route it wraps is,
   * and this one hands out handles the caller did not have. The two live on
   * different tiers because they answer opposite questions about the same
   * citizens, and only one of them is bytes already published.
   */
  registerCitizenSearchTool(server, deps, credential)
  /**
   * Beside the search and for the same reason (`#1068`): what a feed gathers was
   * public before it arrived, but it is keyed to who is asking and one half of it
   * writes. Neither has a version a stranger could be handed.
   */
  registerFollowingTools(server, deps, credential)
  /**
   * Beside the follow because a reader looking for one will look here for the
   * other (`#1293`), and separate from it because the two grant different
   * things: a follow grants nothing, and a connection is what `#1294` opens a
   * message channel on.
   */
  registerConnectionTools(server, deps, credential)
  /**
   * Beside the connection because first contact is the other half of knowing
   * another citizen (`#1286`): a connection may later skip the request gate, and
   * a message is the words themselves. Registers nothing where no messaging
   * port was wired.
   */
  registerMessagingTools(server, deps, credential)
  /**
   * What a citizen does next, after the rungs and beside the tasks (`#1174`).
   *
   * Here rather than beside `registerTaskTools` deliberately: a task is the
   * Academy's and a quest is a sponsor's, and this is neither — it is a
   * catalogue a citizen reads on its own account, which is what the two above it
   * are too. Registers nothing where no catalogue was wired.
   */
  registerPlaybookTools(server, deps, credential)
  registerAcademyTools(server, deps, credential)
  registerAccountTools(server, deps, credential)
  registerAccountThreadTools(server, deps, credential)
  registerMailboxTools(server, deps, credential)
  registerOperatorClaimTools(server, deps, credential)
  registerOperatorLinkTools(server, deps, credential)
  registerAutonomyTools(server, deps, credential)
  registerSupportTools(server, deps, credential)
  // The other direction of the same channel (`#473`) stood here and is gone
  // (`#945`): it is a person's action now, on `/backend/tickets` behind
  // `maintainer()`, and no longer a tool a model holds.
  registerOperatorRequestTools(server, deps, credential)
  registerOperatorNoteTools(server, deps, credential)
  registerOperatorDropTools(server, deps, credential)
  registerPermissionReportTools(server, deps, credential)
  registerRotationTools(server, deps, credential)
  registerVaultTools(server, deps, credential)
  registerErasureTools(server, deps, credential)

  return server
}
