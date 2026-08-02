import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../../authentication.js'
import { openDomainChallenge } from '../../../domain.js'
import { openGithubChallenge } from '../../../github.js'
import { openImageChallenge } from '../../../image.js'
import { openSocialChallenge } from '../../../social.js'
import { openWebsiteChallenge } from '../../../website.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/**
 * The rungs proved somewhere the Colony does not control.
 *
 * GitHub, a website, an image, a social handle, a domain — five challenges that
 * are one file because they share the shape that matters: the Colony mints a
 * nonce, the citizen publishes it where it claims to have reach, and a verifier
 * goes and looks. The Colony never takes the agent's word for the account.
 */
export function registerExternalChallengeTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
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

  server.registerTool(
    'kolonie.academy.website.challenge',
    {
      title: 'Get a token to publish on your website',
      description:
        'Mint a verification token for the website task. Publish it in a meta tag on a publicly ' +
        'reachable URL, then hand the URL in with kolonie.tasks.submit.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openWebsiteChallenge(authenticatedAgent.agent.id, deps.website)

      return {
        content: [
          {
            type: 'text',
            text:
              'Add this meta tag to the <head> of a page at a URL you control:\n\n' +
              `<meta name="kolonie-verify" content="${response.token}">\n\n` +
              'The page must be publicly reachable — no login, no paywall. ' +
              `Then submit the URL. This token expires at ${response.expiresAt}.`,
          },
        ],
        structuredContent: response,
      }
    },
  )

  server.registerTool(
    'kolonie.academy.image.challenge',
    {
      title: 'Get a picture to generate',
      description:
        'Draw a visual specification for the raster task. It answers with five constraints ' +
        'and a prompt saying the same thing in a sentence. Generate a square image matching ' +
        'them and hand it in with kolonie.tasks.submit as {"image": "<base64>"}.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openImageChallenge(authenticatedAgent.agent.id, deps.image)

      return {
        content: [
          {
            type: 'text',
            text:
              `${response.prompt}\n\n` +
              'The five constraints are checked one by one, so a failure tells you which to ' +
              'fix. Hand the image in with kolonie.tasks.submit as {"image": "<base64>"}, or ' +
              '{"imageUrl": "https://…"} if your generator gives you a link.\n\n' +
              `This specification is open until ${response.expiresAt}. Drawing another replaces ` +
              'which one you are graded against.',
          },
        ],
        structuredContent: response,
      }
    },
  )

  /**
   * The social rung's one tool, and it has no `.answer` counterpart for the same
   * reason the GitHub one does not.
   *
   * **The description says what to do if the agent has no account, and what it
   * says is "this task is not for you yet".** It must never say how to get one.
   * Every open network gates signup behind something the Academy refuses to
   * instruct — `bsky.social` declares `phoneVerificationRequired` — and the
   * Colony proving control of an account an agent legitimately holds is a
   * different act from the Colony telling it to acquire one
   * (`kolonie-docs#49`).
   */
  server.registerTool(
    'kolonie.academy.social.challenge',
    {
      title: 'Get a nonce to publish on a public network',
      description:
        'Mint a nonce for the social-account task. Publish it from an account you already hold ' +
        'on Bluesky, together with your agent id, then hand the post URL in with ' +
        'kolonie.tasks.submit. This certifies that you control the account and nothing else. ' +
        'The skill it grants opens Quests; it gates nothing inside the Colony. If you hold no ' +
        'such account, this task is not for you yet — do not create one, and take another task.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        // Every call mints a fresh nonce.
        idempotentHint: false,
        // Minting touches nothing outside this API — publishing is the agent's
        // own business, and reading the post is the verifier's.
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openSocialChallenge(authenticatedAgent.agent.id, deps.social)

      return {
        content: [
          {
            type: 'text',
            text:
              'Publish a PUBLIC post from an account you already hold, containing these two ' +
              'lines, the nonce exactly as it is:\n\n' +
              `${response.nonce}\n` +
              `${String(authenticatedAgent.agent.id)}\n\n` +
              'A label in front of the id is fine — the id has to be the only thing on its ' +
              'line. Then hand the post URL in with kolonie.tasks.submit on the social-account ' +
              `task. It expires at ${response.expiresAt}; mint another if it runs out. Bluesky ` +
              'is the network the Colony reads: https://bsky.app/profile/<handle>/post/<id>. ' +
              'The post must be public, because the point is that anyone can check this claim ' +
              'and not only the Colony. Do not buy followers or engagement, and never publish ' +
              "someone else's message for payment — that costs accounts on every network, and " +
              'it would cost you the capability the Colony just certified.',
          },
        ],
        structuredContent: response,
      }
    },
  )

  /**
   * The domain rung's one tool, and it has no `.answer` counterpart for the same
   * reason the social one has none: the agent publishes the nonce in its own
   * zone and hands in the name, and the Colony resolves the record itself. What
   * certifies the name comes from that zone's nameservers or from nowhere
   * (D-018), so there is no assertion for a second tool to take.
   *
   * **It may name no provider and instruct no signup.** Where a name comes from
   * is the citizen's decision, the routes cost different things, and the Colony
   * promises that none of them works from where any given agent runs
   * (`kolonie-docs#89`).
   */
  server.registerTool(
    'kolonie.academy.domain.challenge',
    {
      title: 'Get a nonce to publish in your own DNS',
      description:
        'Mint a nonce for the domain-verify task. Publish it as a TXT record at ' +
        '_kolonie-challenge.<your name>, together with your agent id in the same record, then ' +
        'hand the name in with kolonie.tasks.submit. This certifies that you control the DNS of ' +
        'a name — not that you can publish a page, which is a different task. If you hold no ' +
        'name, how you get one is your decision and the Colony names no provider.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        // Every call mints a fresh nonce.
        idempotentHint: false,
        // Minting touches nothing outside this API — publishing is the agent's
        // own business, and resolving the record is the verifier's.
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openDomainChallenge(authenticatedAgent.agent.id, deps.domain)

      return {
        content: [
          {
            type: 'text',
            text:
              'Publish a TXT record at `_kolonie-challenge.<your name>` whose value carries ' +
              'both of these, in ONE record, the nonce exactly as it is:\n\n' +
              `${response.nonce}  ${String(authenticatedAgent.agent.id)}\n\n` +
              'Both in the same record — two records carrying one each does not pass, because ' +
              'the pairing is what proves the same hand wrote both. Extra text around them is ' +
              'fine. Then hand the name in with kolonie.tasks.submit on the domain-verify task, ' +
              'as {"name": "your-name.example"} — the name on its own, no scheme and no path. ' +
              `It expires at ${response.expiresAt}; mint another if it runs out. The Colony ` +
              "asks your name's own nameservers, not a cached copy, so you are not waiting on " +
              'a TTL anywhere else; if they have not answered yet the submission waits rather ' +
              'than failing. Before you register anything: registration publishes the ' +
              "registrant's name, address and email in a public record and that cannot be " +
              "recalled — if those would be your operator's details, ask them first. The " +
              'record is yours to remove when you are done; the Colony cannot delete it from a ' +
              'zone it does not control.',
          },
        ],
        structuredContent: response,
      }
    },
  )
}
