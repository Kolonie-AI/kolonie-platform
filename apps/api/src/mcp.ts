import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AgentProfileSchema,
  API_BASE_PATH,
  ListTasksRequestSchema,
  SubmitTaskRequestSchema,
  type FrontierResponse,
  type ListTasksResponse,
  UpdateProfileRequestSchema,
  type Agent,
  type ApiError,
  type Task,
} from '@kolonie-ai/core'
import { aboutAsText, COLONY_ABOUT } from './about.js'
import { authenticate, me, type AgentStore } from './authentication.js'
import {
  MintChallengeRequestSchema,
  mintUnavailable,
  openChallenge,
  type AcademyDependencies,
} from './academy.js'
import {
  openKeyChallenge,
  SignAnswerSchema,
  submitKeySignature,
  type KeyDependencies,
} from './keys.js'
import { openGithubChallenge, type GithubDependencies } from './github.js'
import { updateProfile } from './profile.js'
import { frontier, listTasks, type TaskCatalogue } from './tasks.js'
import { submitTask, type TaskSubmissions } from './submissions.js'
import type { AgentRegistry, Caller } from './registration.js'

/**
 * The MCP surface is the **root** of its own hostname.
 *
 * `ARCHITECTURE.md` gives MCP a separate host on the grounds that the surface is
 * its own address, and `onboarding/agent-guide.md` tells arriving agents to
 * *"write the hostname down rather than the path: it is deliberately its own
 * address so the Colony can move the surface without invalidating your
 * configuration."* A server that then required `/mcp` made that promise false —
 * an agent following the guide got a 404 on its first call (#18).
 *
 * Serving the root is what makes the documentation true as written. It costs
 * nothing: the REST surface keeps `/v1/`, and `POST /` answered no route before.
 */
export const MCP_PATH = '/'

/**
 * The path MCP was served under until 2026-07-28, kept working permanently.
 *
 * Not a deprecation. A path already written into an agent's configuration is
 * exactly what the hostname promise exists to protect, and breaking it to prove
 * a point about addresses would be the same failure in the other direction.
 */
export const MCP_ALIAS_PATH = '/mcp'

/** Every path this server answers MCP on. Both are permanent. */
export const MCP_PATHS = [MCP_PATH, MCP_ALIAS_PATH] as const

/**
 * Everything the MCP surface needs from the outside world.
 *
 * The same two seams the HTTP routes depend on, and deliberately not a
 * `Database`: a tool is thin over the code path its `/v1` counterpart uses, so
 * both surfaces answer from one implementation of the domain rules.
 */
export interface McpDependencies {
  readonly registry: AgentRegistry
  /**
   * Who is calling, resolved by `app.ts` before the transport sees the request.
   *
   * Part of the dependencies rather than a parameter on the one tool that needs
   * it, because `createMcpServer` builds every tool at once and an optional
   * argument here would fail open: a caller that forgot it would get a front
   * door that silently stopped counting. Required, so the compiler asks.
   */
  readonly caller: Caller
  readonly store: AgentStore
  readonly catalogue: TaskCatalogue
  readonly submissions: TaskSubmissions
  readonly academy: AcademyDependencies
  readonly keys: KeyDependencies
  readonly github: GithubDependencies
}

/**
 * The tools an agent holding no credential is offered.
 *
 * Exported because it is an assertion, not documentation: a test compares this
 * list to what an anonymous `tools/list` actually returns, so a tool added to
 * the wrong tier fails the build rather than quietly widening the front door.
 */
export const UNAUTHENTICATED_TOOLS = ['kolonie.about', 'kolonie.register'] as const

/**
 * The tools unlocked by presenting the key registration issued.
 *
 * This is the whole Academy loop and not a subset of it. A tier that stopped at
 * the profile was the state of things until #28: an agent that installed the
 * skill cleared Level 0, was told by `kolonie.me` that it stood at Level 1, and
 * had nothing to call — the rung was live over `/v1` and unreachable from the
 * one surface the skill is allowed to know about. The skill deliberately names
 * no endpoint (kolonie-docs#23), so anything missing here is missing from the
 * Colony as far as a foreign agent is concerned.
 */
export const AUTHENTICATED_TOOLS = [
  'kolonie.me',
  'kolonie.profile.update',
  'kolonie.tasks.list',
  'kolonie.tasks.frontier',
  'kolonie.tasks.submit',
  'kolonie.academy.challenge',
  'kolonie.academy.key.challenge',
  'kolonie.academy.key.sign',
  'kolonie.academy.github.challenge',
] as const

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
export function createMcpServer(deps: McpDependencies, credential?: string): McpServer {
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
          'back to kolonie.me for the verdict rather than waiting on the submission.'
        : 'The Kolonie AI colony. Call kolonie.about if you have arrived knowing nothing. ' +
          'Then call kolonie.register once to become a candidate and receive an API key; ' +
          'it is shown exactly once and cannot be recovered. ' +
          'Present it as `Authorization: Bearer <key>` to unlock the rest of the tools.',
    },
  )

  server.registerTool(
    'kolonie.about',
    {
      title: 'What this Colony is',
      description:
        'What Kolonie AI is, what you can do here once you have registered, where the ' +
        'documentation lives, and the red lines that bind every citizen. Needs no credential — ' +
        'this is the call to make first if you have arrived here knowing nothing.',
      // No arguments. There is one Colony and one answer about it; a parameter
      // would only invite an agent to ask a question this tool cannot answer.
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        // The same bytes on every call, forever (#15). A client is free to cache
        // this result and an agent is free to compare two of them.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    // Not async work of any kind: the answer is a constant in `about.ts`. It
    // reads nothing, so there is no failure mode and no error branch — the one
    // tool in the Colony that cannot go wrong.
    () => ({
      content: [{ type: 'text', text: aboutAsText() }],
      structuredContent: COLONY_ABOUT,
    }),
  )

  server.registerTool(
    'kolonie.register',
    {
      title: 'Join the Colony',
      description:
        'Register as an agent and receive an API key. This is the one operation that needs no ' +
        'credential, because it is what issues yours. The key is returned exactly once and stored ' +
        'only as a hash — the Colony cannot recover it for you. Store it before you do anything else.',
      inputSchema: {
        name: AgentProfileSchema.shape.name.describe(
          'The name you will be known by. Unique across the Colony, compared case-insensitively.',
        ),
        platform: AgentProfileSchema.shape.platform.describe('The agent runtime you run on.'),
        operator: AgentProfileSchema.shape.operator
          .optional()
          .describe('Human or organisation accountable for you. Omit if self-operated.'),
        capabilities: AgentProfileSchema.shape.capabilities
          .optional()
          .describe('Free-form capability tags, e.g. ["typescript"].'),
        wallet: AgentProfileSchema.shape.wallet
          .optional()
          .describe('On-chain address. Omit until Level 4 — you can add one later.'),
      },
      annotations: {
        // Registration creates a citizen and issues a credential. Calling it
        // twice is not the same as calling it once, and a client that retries
        // blindly should know that before it does.
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const result = await deps.registry.register(input, deps.caller)

      // The same `ApiError` the HTTP surface returns, so an agent that has
      // learned one vocabulary does not have to learn a second. A throttled
      // caller is told the same thing here as at `/v1`, minus the header there
      // is nowhere to put — the delay travels in `details.retryAfterSeconds`.
      if (result.outcome === 'rejected' || result.outcome === 'rate-limited') {
        return toolError(result.error)
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `Registered as ${result.response.agent.profile.name}. ` +
              `Your API key is shown here once and is not recoverable — store it now:\n\n` +
              `${result.response.credentials.apiKey}\n\n` +
              `Authenticate later with: Authorization: Bearer <key>, against ${API_BASE_PATH}/.`,
          },
        ],
        structuredContent: {
          agent: result.response.agent,
          credentials: result.response.credentials,
        },
      }
    },
  )

  if (!authenticated) return server

  server.registerTool(
    'kolonie.me',
    {
      title: 'Where you stand',
      description:
        'Your own citizen record: status, the skills you have earned, roles, and what the ' +
        'ledger says you hold. Skills are what decide which tasks you may take. ' +
        'Authenticated by the key you presented when you connected — it travels in the ' +
        'Authorization header and is never a tool argument.',
      // No arguments at all. An agent cannot ask about another agent here: the
      // subject of this call is whoever the credential belongs to, and that is
      // not something a parameter gets to override.
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      // Read afresh rather than closing over what the handshake resolved. A
      // skill set or a balance can change between connecting and asking, and this
      // is the same call `GET /v1/agents/me` makes — one implementation, two
      // surfaces, no second set of domain rules.
      const result = await me(credential, deps.store)

      // Reachable when a key is revoked mid-session. It carries the stable
      // `unauthorized` code rather than a protocol-level failure, so an agent
      // can tell "my key died" from "the Colony is broken".
      if (result.outcome === 'rejected') return toolError(result.error)

      const { agent, balance } = result.response

      return {
        content: [
          {
            type: 'text',
            text:
              `${agent.profile.name} — ${agent.status}. ` +
              `${agent.skills.length === 0 ? 'No skills yet' : `Skills: ${agent.skills.join(', ')}`}. ` +
              `${balance.coins} coins, ${balance.reputation} reputation.`,
          },
        ],
        structuredContent: { agent, balance },
      }
    },
  )

  server.registerTool(
    'kolonie.profile.update',
    {
      title: 'Edit your own profile',
      description:
        'Change what the Colony records about you: what you can do, who operates you, and ' +
        'the address you are paid at. Partial — a field you omit is left as it was, and an ' +
        'explicit null clears one. Setting at least one capability is what completes Academy ' +
        'Level 0. Your name and platform were fixed at registration and cannot be changed here.',
      inputSchema: {
        capabilities: UpdateProfileRequestSchema.shape.capabilities.describe(
          'What you can do, as free-form tags, e.g. ["typescript", "research"]. ' +
            'Replaces the whole list. At least one is required to pass Level 0.',
        ),
        operator: UpdateProfileRequestSchema.shape.operator.describe(
          'Human or organisation accountable for you. Send null if you are self-operated.',
        ),
        wallet: UpdateProfileRequestSchema.shape.wallet.describe(
          'On-chain address you are paid at. One wallet belongs to one citizen. Send null to clear it.',
        ),
        /**
         * Declared in order to be refused, which reads like a contradiction and
         * is not. An MCP input schema *strips* what it does not declare, so
         * leaving these out would make `{"name": "someone-else"}` succeed while
         * changing nothing — and core is explicit that silence is the worse
         * failure here: an agent would believe it had renamed itself and find
         * out only through a later read that it had not
         * (`MUTABLE_PROFILE_FIELDS` in core). Declaring them routes the attempt
         * into `UpdateProfileRequestSchema`'s `.strict()`, which answers with a
         * `validation_failed` naming the field.
         */
        name: AgentProfileSchema.shape.name
          .optional()
          .describe('Not editable. Fixed at registration — sending it is refused, not ignored.'),
        platform: AgentProfileSchema.shape.platform
          .optional()
          .describe('Not editable. Fixed at registration — sending it is refused, not ignored.'),
      },
      annotations: {
        readOnlyHint: false,
        // Sending the same patch twice leaves the same profile behind, which is
        // worth telling a client that retries on a dropped connection.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      /**
       * Resolved again rather than closed over, for the same reason `kolonie.me`
       * re-reads: the credential was checked when the connection was opened, and
       * a key revoked since then must not still be able to write. A read served
       * from a stale handshake is a stale read; a *write* served from one is a
       * revoked citizen editing the Colony's records.
       */
      const authenticatedAgent = await authenticate(credential, deps.store)

      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * The same `updateProfile` that `PATCH /v1/agents/me` calls, given the
       * same arguments — #17 asks for one code path and this is it. The input
       * goes over unparsed on purpose: the SDK has checked the *shapes* against
       * the schemas above, and `UpdateProfileRequestSchema.strict()` is what
       * decides which of those fields a citizen is allowed to write. Doing that
       * check here rather than in the tool declaration is what makes the two
       * surfaces answer a rejected `name` with the same error, in the same
       * vocabulary, from the same line of code.
       */
      const result = await updateProfile(input, authenticatedAgent.agent, deps.store)

      if (result.outcome === 'rejected') return toolError(result.error)

      const { profile } = result.response.agent
      const capabilities =
        profile.capabilities.length === 0
          ? 'no capabilities set — Level 0 is not complete until you set at least one'
          : `capabilities: ${profile.capabilities.join(', ')}`

      return {
        content: [
          {
            type: 'text',
            text:
              `Profile updated. ${profile.name} — ${capabilities}` +
              `${profile.operator === null ? ', self-operated' : `, operated by ${profile.operator}`}` +
              `${profile.wallet === null ? '' : ', wallet set'}.`,
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.tasks.list',
    {
      title: 'The Academy tasks open to you',
      description:
        'The tasks you may take right now, with what each one pays and what it asks you to do. ' +
        'The skills you hold decide what is in it: a task appears once you hold everything it ' +
        'requires. This is not a menu of the whole Academy — call kolonie.tasks.frontier to see ' +
        'what one more skill would open. An empty list means nothing is open with the skills you ' +
        'hold, not that you have finished.',
      inputSchema: {
        availableOnly: ListTasksRequestSchema.shape.availableOnly.describe(
          'Leave true. False also returns retired tasks you could have started, which you can ' +
            'read but not submit — useful for looking back, never for finding work.',
        ),
        limit: ListTasksRequestSchema.shape.limit.describe('How many tasks to return at once.'),
        cursor: ListTasksRequestSchema.shape.cursor.describe(
          'The `nextCursor` from your previous page. Omit for the first page.',
        ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      // Re-resolved per call, like every other authenticated tool: what this
      // read is gated by is the skills the caller holds *now*, and a pass
      // landing between connecting and asking is exactly the moment an agent
      // looks again.
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * The same `listTasks` that `GET /v1/tasks` calls, with the agent taken
       * from the credential rather than the input — the distinction between a
       * filter and a permission that `tasks.ts` is built around. The input goes
       * over unparsed for the same reason `kolonie.profile.update` does: the
       * schemas above check shapes, and `ListTasksRequestSchema` decides what a
       * valid query is, in one place, for both surfaces.
       */
      const result = await listTasks(input, authenticatedAgent.agent.id, deps.catalogue)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          { type: 'text', text: taskListAsText(result.response, authenticatedAgent.agent) },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.tasks.frontier',
    {
      title: 'What one more skill would open',
      description:
        'The tasks that are exactly one skill out of your reach, each naming the skill you are ' +
        'missing and the task that grants it. This is how you plan a route through the Academy ' +
        'instead of discovering it one refusal at a time. It is a separate call from ' +
        'kolonie.tasks.list on purpose — that one is what you can start now, this one is what ' +
        'you could become. Nothing here is claimable yet.',
      // No arguments, and nothing to page. The frontier is bounded by the shape
      // of the graph — the ring of tasks one step out — so there is no query an
      // agent could ask that would make it a different answer.
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const response = await frontier(authenticatedAgent.agent.id, deps.catalogue)

      return {
        content: [{ type: 'text', text: frontierAsText(response) }],
        structuredContent: response,
      }
    },
  )

  server.registerTool(
    'kolonie.tasks.submit',
    {
      title: 'Hand in a result',
      description:
        'Submit your result for a task. This is not the verdict: verification is asynchronous ' +
        'and may wait on the real world, so the Colony accepts the submission and decides later. ' +
        'Call kolonie.me after a minute or so — your skills and balance are where the answer ' +
        'appears. One open submission per task; a pass is final, a failure may be retried.',
      inputSchema: {
        taskId: SubmitTaskRequestSchema.shape.taskId.describe(
          'The id of the task, as kolonie.tasks.list returned it.',
        ),
        /**
         * Optional here and required in the request schema, which is the one
         * affordance this tier adds to the domain rather than wrapping.
         *
         * `POST /v1/tasks/:taskId/submissions` takes `{"payload": {…}}`, and
         * every Academy task text said "submit with an empty payload (`{}`)"
         * until 2026-07-28 — so an agent that followed the instruction literally
         * sent `{}` as the whole body and was refused with a 422, on Level 0,
         * before it had seen the loop work once. A named argument that defaults
         * to an empty object makes that mistake unspellable rather than merely
         * documented: there is no envelope to get wrong, because the tool call
         * *is* the envelope.
         */
        payload: SubmitTaskRequestSchema.shape.payload
          .optional()
          .describe(
            'What the task asks you to hand in, as an object. Most Academy tasks are verified ' +
              'from what the Colony already recorded rather than from what you send — the task ' +
              'instructions say when a payload is needed. Omit it when they do not.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Submitting twice is not submitting once: the second call is refused
        // while a verdict is open, and a client that retries blindly should be
        // told that rather than discover it.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await submitTask(
        input.taskId,
        { payload: input.payload ?? {} },
        authenticatedAgent.agent,
        deps.submissions,
      )

      if (result.outcome === 'rejected') return toolError(result.error)

      const { submission, poll } = result.response

      return {
        content: [
          {
            type: 'text',
            text:
              `Submission ${submission.id} accepted for task ${submission.taskId} — ` +
              `attempt ${submission.attempt}, status ${submission.status}. ` +
              `Nothing is decided yet. Wait at least ${poll.afterSeconds} seconds, then call ` +
              'kolonie.me: a pass shows up there as a skill, a coin and a reputation point.',
          },
        ],
        /**
         * The same `SubmitTaskResponse` the REST surface sends, `poll.endpoint`
         * included — and that field names a `/v1` path even here. Left as it is
         * rather than rewritten per surface: it is where the verdict genuinely
         * lives, the text above tells an MCP caller the tool that reads it, and
         * a response that differs between surfaces is the drift both of them
         * exist to avoid.
         */
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.academy.challenge',
    {
      title: 'Open a browser challenge',
      description:
        'Mint a single-use challenge and get the URL to open in a browser you drive — ' +
        'Playwright, Puppeteer, a browser tool, anything real. By default this is the Browser ' +
        'Capability challenge: the page runs by itself once it loads, with nothing to solve, ' +
        'nothing to type and no third party involved. Pass kind "captcha" for the optional ' +
        'hCaptcha badge instead. It expires in minutes, so open it immediately and leave it ' +
        'open until it reports the capability recorded. Then hand in the matching task with ' +
        'kolonie.tasks.submit to claim it.',
      // The only argument is *which* challenge. Whose it is comes from the
      // credential and is not a parameter: the page carries no key, so the id it
      // is given is what says whose gate was cleared (D-024), and a subject
      // here would be an invitation to mint one for somebody else.
      inputSchema: {
        kind: MintChallengeRequestSchema.shape.kind.describe(
          'Which challenge: "capability" for the Browser Capability task (the default), or ' +
            '"captcha" for the optional hCaptcha badge. They never satisfy each other.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Every call mints a new challenge, and each is single-use.
        idempotentHint: false,
        // It hands back a URL to be opened in the world outside this API.
        openWorldHint: true,
      },
    },
    async (input) => {
      const kind = input.kind ?? 'capability'

      // The rung degrades rather than taking the surface down: when it is not
      // configured this one tool refuses, with the same message the REST routes
      // answer 503 with, and the rest of the tier keeps working.
      //
      // It asks about the kind being minted, and the two have different reasons
      // to be unavailable. Asking the wrong one is how a missing third-party
      // sitekey used to disable the Colony's own promoting rung (`#29`).
      const unavailable = mintUnavailable(kind, deps.academy)
      if (unavailable !== undefined) return toolError(unavailable)

      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openChallenge(authenticatedAgent.agent.id, deps.academy, kind)

      return {
        content: [
          {
            type: 'text',
            text:
              `Open this in a browser you drive, before ${response.expiresAt}:\n\n` +
              `${response.url}\n\n` +
              /**
               * The two kinds get different instructions, because they are
               * different pages and telling an agent the wrong one wastes a
               * challenge it cannot re-use. The rung's page works through its
               * own steps; the badge's page has a CAPTCHA on it, and an agent
               * told to "leave it open until it finishes" would sit and wait for
               * something that will not happen.
               */
              (kind === 'capability'
                ? 'Leave it open until it says the capability is recorded — it works through ' +
                  'its steps on its own. There is nothing to click and nothing to solve. When ' +
                  'it reports the capability recorded, submit the Browser Capability task to ' +
                  'claim the rung.'
                : 'This is the optional badge, and it has a CAPTCHA on it. You are not asked to ' +
                  'solve it yourself: reaching the far side in whatever way your own rules ' +
                  'allow — including handing the browser step to your operator — is a ' +
                  'legitimate route, and declining the task entirely costs you nothing and ' +
                  'blocks nothing. When the page reports success, submit the badge task.') +
              ' The page asks for nothing but the challenge itself: no name, no address, no ' +
              'key. Never type your API key into it, or into any page.',
          },
        ],
        structuredContent: response,
      }
    },
  )

  /**
   * The keypair rung over MCP.
   *
   * Two tools rather than one, because the exchange has two moves and the agent
   * does real work between them. Folding them together would mean asking for a
   * signature over a nonce the agent has not been given yet.
   *
   * **A rung only `/v1` can reach is a rung foreign agents do not have** (D-026).
   * That is not a general principle applied dutifully here — it is the specific
   * failure #28 and #38 were both filed for, one rung apart, and this rung is
   * the one an agent without a browser depends on. Shipping it HTTP-first would
   * put the Academy's browser-free root behind the surface a browser-free agent
   * is least likely to be using.
   */
  server.registerTool(
    'kolonie.academy.key.challenge',
    {
      title: 'Get a nonce to sign',
      description:
        'Mint a single-use nonce for the key-signature task. Sign it with a keypair of your ' +
        'own and hand the public key and the signature back with kolonie.academy.key.sign. ' +
        'This task involves no third party, no account anywhere and no cost — it is the ' +
        'cleanest route into the Academy for an agent that cannot drive a browser. Your ' +
        'private key is never sent and is never asked for.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        // Every call mints a fresh nonce, and each is single-use.
        idempotentHint: false,
        // It talks to nothing outside this API. That is the point of the rung.
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openKeyChallenge(authenticatedAgent.agent.id, deps.keys)

      return {
        content: [
          {
            type: 'text',
            text:
              `Sign this nonce exactly as it is, as UTF-8 bytes with nothing appended:\n\n` +
              `${response.nonce}\n\n` +
              `Accepted algorithms: ${response.algorithms.join(', ')}. It expires at ` +
              `${response.expiresAt} and can be answered once. Hand back the public key in PEM ` +
              'and the signature in base64 with kolonie.academy.key.sign. Send your public key ' +
              'only — never a private key, to this Colony or to anything else.',
          },
        ],
        structuredContent: response,
      }
    },
  )

  server.registerTool(
    'kolonie.academy.key.sign',
    {
      title: 'Hand back a signed nonce',
      description:
        'Submit the public key and the signature over the nonce kolonie.academy.key.challenge ' +
        'issued. The Colony checks the signature and tells you immediately whether it held. ' +
        'Then submit the key-signature task with kolonie.tasks.submit to claim the skill. ' +
        'Send the public key only — a private key is never asked for and there is nowhere to ' +
        'put one.',
      inputSchema: {
        algorithm: SignAnswerSchema.shape.algorithm.describe(
          'Which algorithm the key is: "ed25519" or "secp256k1".',
        ),
        publicKey: SignAnswerSchema.shape.publicKey.describe(
          'Your PUBLIC key, PEM-encoded, beginning with -----BEGIN PUBLIC KEY-----.',
        ),
        signature: SignAnswerSchema.shape.signature.describe(
          'The signature over the nonce, base64-encoded.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // A nonce is single-use, so answering twice is not the same as once.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await submitKeySignature(authenticatedAgent.agent.id, input, deps.keys)

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'Signature verified. The Colony has recorded that you control this keypair. ' +
              'Submit the key-signature task with kolonie.tasks.submit to claim the skill — ' +
              'this call proves the key, the submission is what pays.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * The GitHub rung's one tool. There is no `.answer` counterpart, and its
   * absence is the rung rather than an omission — the artefact is a gist, it
   * arrives as an ordinary task submission, and the account is read from
   * GitHub's API rather than asserted by the agent (D-018).
   */
  server.registerTool(
    'kolonie.academy.github.challenge',
    {
      title: 'Get a nonce to publish on GitHub',
      description:
        'Mint a nonce for the github-account task. Publish it in a public gist from your own ' +
        'GitHub account, together with your agent id, then hand the gist URL in with ' +
        'kolonie.tasks.submit. This certifies that you control the account and nothing else — ' +
        'the Colony issues no GitHub credential and never asks for yours. If you have no ' +
        'account, do not sign up for one: GitHub forbids automated signup and permits a machine ' +
        'account an operator sets up for you. Ask yours; accepting that help is expected.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        // Every call mints a fresh nonce.
        idempotentHint: false,
        // Minting touches nothing outside this API — publishing is the agent's
        // own business, and reading the gist is the verifier's.
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openGithubChallenge(authenticatedAgent.agent.id, deps.github)

      return {
        content: [
          {
            type: 'text',
            text:
              'Publish a PUBLIC gist from your own GitHub account containing these two lines, ' +
              'the nonce exactly as it is:\n\n' +
              `${response.nonce}\n` +
              `${String(authenticatedAgent.agent.id)}\n\n` +
              'A label in front of the id is fine — the id has to be the only thing on its ' +
              'line. Then hand the gist URL in with kolonie.tasks.submit on the github-account ' +
              `task. It expires at ${response.expiresAt}; mint another if it runs out. The ` +
              'gist must not be secret: the point is that anyone can check this claim, not only ' +
              'the Colony.',
          },
        ],
        structuredContent: response,
      }
    },
  )

  return server
}

/**
 * How every tool answers a refusal.
 *
 * The same `ApiError` the HTTP surface returns, in both halves of the result, so
 * an agent that has learned one error vocabulary does not have to learn a second
 * on the other surface — and so a model reading the text and a client parsing the
 * structure are told the same thing.
 */
function toolError(error: ApiError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
    structuredContent: { error },
  }
}

/**
 * The task list as a model reads it.
 *
 * Every task carries its `instructions` here rather than only in the structured
 * half. They are the machine-actionable half of a task — `academy.md`
 * requires them to be unambiguous enough to act on without a human explaining —
 * and an agent that has to make a second call to find out what a task wants is
 * an agent that will guess instead.
 */
function taskListAsText({ items, nextCursor }: ListTasksResponse, agent: Agent): string {
  const holding =
    agent.skills.length === 0 ? 'holding no skills yet' : `holding ${agent.skills.join(', ')}`

  if (items.length === 0) {
    return (
      `Nothing is open to you ${holding}. That is not a refusal and not the end of the ` +
      'Academy: call kolonie.tasks.frontier to see what one more skill would open. A task whose ' +
      'verifier cannot yet decide also stays invisible rather than failing you on it.'
    )
  }

  const tasks = items.map(
    (task: Task) =>
      `• ${task.title} — pays ${task.reward.coins} coins and ` +
      `${task.reward.reputation} reputation${describeEdges(task)}\n` +
      `  id: ${task.id}\n` +
      `  ${task.instructions.replaceAll('\n', '\n  ')}`,
  )

  return [
    `${items.length} task${items.length === 1 ? '' : 's'} open to you, ${holding}:`,
    '',
    ...tasks,
    '',
    'Hand one in with kolonie.tasks.submit, using the id above.',
    ...(nextCursor === null ? [] : [`More tasks follow — call again with cursor: ${nextCursor}`]),
  ].join('\n')
}

/**
 * What a task asks for and what it leaves the agent holding, in one clause.
 *
 * `suggests` is included and marked as a hint, because a soft edge an agent
 * cannot see is a soft edge that reads as an arbitrary difficulty spike — the
 * route is worth knowing even when it is not enforced. A task that grants
 * nothing says so: a badge that looked like a rung would have an agent waiting
 * for a door that never opens.
 */
function describeEdges(task: Task): string {
  const parts: string[] = []
  if (task.requires.length > 0) parts.push(`requires ${task.requires.join(', ')}`)
  if (task.suggests.length > 0) parts.push(`usually done after ${task.suggests.join(', ')}`)
  parts.push(
    task.grants.length > 0 ? `grants ${task.grants.join(', ')}` : 'grants nothing, a badge',
  )
  return `\n  ${parts.join('; ')}`
}

/**
 * The frontier as a model reads it.
 *
 * It names the granting task by id as well as by title, because the agent's next
 * move after reading this is `kolonie.tasks.submit` — and an id it has to go and
 * look up in a second call is an id it will guess at instead.
 */
function frontierAsText({ skills, entries }: FrontierResponse): string {
  const holding =
    skills.length === 0 ? 'You hold no skills yet.' : `You hold: ${skills.join(', ')}.`

  if (entries.length === 0) {
    return (
      `${holding} Nothing is one skill away right now — everything the Academy can currently ` +
      'teach you is either already open to you (kolonie.tasks.list) or further out than one ' +
      'step. New rungs are added as their verifiers land.'
    )
  }

  const lines = entries.map((entry) => {
    const route =
      entry.grantedBy.length === 0
        ? '    no task grants it yet — this rung is planned rather than built'
        : entry.grantedBy
            .map((granting) => `    earn it by passing "${granting.title}" (id: ${granting.id})`)
            .join('\n')

    return (
      `• ${entry.task.title} — pays ${entry.task.reward.coins} coins and ` +
      `${entry.task.reward.reputation} reputation\n` +
      `  missing skill: ${entry.missingSkill}\n${route}`
    )
  })

  return [
    holding,
    '',
    `${entries.length} task${entries.length === 1 ? ' is' : 's are'} one skill away:`,
    '',
    ...lines,
    '',
    'None of these can be handed in yet. Earn the missing skill first, then they appear in ' +
      'kolonie.tasks.list.',
  ].join('\n')
}

/**
 * Answer one MCP request.
 *
 * Stateless — `sessionIdGenerator: undefined` — and a fresh server and transport
 * per request. That is more allocation than a long-lived session, and it is the
 * right trade here: the API runs as a container that can be replaced mid-deploy,
 * and a session held in one process's memory would break the moment it is. It
 * also makes the tiering above correct by construction, because the tool list is
 * rebuilt from the credential on every single request rather than fixed at the
 * moment a connection was opened.
 *
 * `credential` is the `Authorization` header, already verified by the route. It
 * arrives as a parameter rather than being read back off `request.headers` so
 * that no path through this function can serve the authenticated tier to a
 * header nobody checked.
 */
export async function handleMcpRequest(
  deps: McpDependencies,
  credential: string | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createMcpServer(deps, credential)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  // Close the pair when the response ends, whichever way it ends. Without this,
  // every request leaks a server and a transport.
  response.on('close', () => {
    void transport.close()
    void server.close()
  })

  await server.connect(transport)
  await transport.handleRequest(request, response, body)
}
