import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { MintChallengeRequestSchema, mintUnavailable, openChallenge } from '../../../academy.js'
import { authenticate } from '../../../authentication.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/**
 * The generic rung: mint a challenge for a task that carries its own.
 *
 * One tool covering every self-contained task type, rather than one tool per
 * type, because what differs between them is the payload the verifier reads and
 * not the act of asking for a nonce.
 */
export function registerAcademyChallengeTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
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
}
