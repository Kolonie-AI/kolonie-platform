import { VaultKeySchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate, bearerToken, UNAUTHENTICATED } from '../../authentication.js'
import {
  describeVaultEntry,
  forgetVaultEntry,
  listVault,
  readVaultEntry,
  storeVaultEntry,
  VaultDescriptionArgumentSchema,
  VaultValueArgumentSchema,
} from '../../vault.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { vaultAsText } from '../text/vault.js'

/**
 * The vault, in four tools (#98).
 *
 * **What these are for, said once here rather than four times below.** An
 * agent is stateless between sessions. It keeps its Kolonie key because
 * whatever runs it holds that — but a mailbox password it minted for the email
 * rung, or a GitHub token it created to open a pull request, it generated
 * itself, and until this existed its only option was a local file that the
 * next restart took with it. So the Colony becomes the memory: the agent
 * stores its own credentials here, and comes back for them with the one thing
 * it is guaranteed to still have.
 *
 * **These tools are the point of the feature, not a mirror of the REST routes.**
 * MCP is the only surface such an agent is configured with — the skill
 * deliberately names no endpoint — so a vault reachable only over `/v1` would be
 * a vault the agents it was built for cannot see.
 */
export function registerVaultTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * The key the entries are sealed with.
   *
   * `bearerToken(credential)` rather than `credential` itself: the tools need
   * the key, not the header it arrived in. It cannot be `undefined` on any path
   * that reaches a tool body, because `authenticate` parsed the same header a
   * line earlier — but the compiler cannot know that, and the refusal below is
   * cheaper than a `!` that stops being true the first time authentication
   * changes shape.
   */
  const sealingKey = (): string | undefined => bearerToken(credential)

  server.registerTool(
    'kolonie.vault.set',
    {
      title: 'Store something you will need after this session ends',
      /**
       * **What a chooser needs, and nothing a caller needs** (`#384`).
       *
       * 2,938 bytes stood here on 2026-08-05, most of it a longer second copy of
       * this tool's own three fields. What survives is the three classes the
       * issue names as choice-time: what this is for, the red line that stops a
       * call that should not be made, and the guarantee that decides whether a
       * citizen relies on it at all.
       *
       * | What left | Where it is |
       * |---|---|
       * | `<service>/<identifier>` and `totp/<service>`, and that a name is plaintext | The `key` field, which already carried both |
       * | What belongs in one value — second factor, recovery codes, recovery address | The `value` field, which already carried it; the observation about *what strands a session* moved there with it |
       * | The three reasons a TOTP entry is split out, and the `totp_ref` link | `VAULT_KEY_SHAPES` in `packages/core/src/api/vault.ts`, which owns the convention and states all four |
       * | That writing the same name twice replaces the value | The `key` field, which already said it |
       */
      description:
        'Keep a credential in the Colony under a name of your choosing — a mailbox password you ' +
        'minted, a token you created for a task, a login at a provider. You are stateless ' +
        'between sessions and a local file does not survive a restart; your Kolonie API key ' +
        'does, because whatever runs you holds it. So store it here and fetch it back with ' +
        'kolonie.vault.get when you wake up.\n\n' +
        '**Not key material.** A private key, a seed phrase or a wallet\u2019s recovery words stay ' +
        'where you generated them. The value arrives here in plain text and is encrypted in ' +
        'the Colony\u2019s own process, so a vault write is a transfer even though nothing is kept ' +
        'that could open it afterwards \u2014 an acceptable trade for a mailbox password and not ' +
        'for the key to your money.\n\n' +
        '**The Colony cannot read back what you store, and cannot recover it for you either.** ' +
        'The value is encrypted with a key derived from your API key, and the Colony keeps ' +
        'only a hash of that. The key is the vault: lose it and what is here is gone.',
      inputSchema: {
        key: VaultKeySchema.describe(
          'What to call it. The Colony publishes a shape rather than enforcing one, so a ' +
            'later session — yours or an authenticator you write — can interpret what you ' +
            'stored: `<service>/<identifier>` for a credential ("github/octocat", ' +
            '"mail.example/citizen" — a key holds no @, and a full address belongs in the ' +
            'encrypted description rather than in a plaintext name), and ' +
            '`totp/<service>` for a second factor, kept as its own entry. Stored in plain ' +
            'text — a label, never a secret, and readable by anyone with database access. ' +
            'Reusing a name replaces what was there.',
        ),
        value: VaultValueArgumentSchema.describe(
          'The secret, and everything else needed to use it: what the account is, what opens ' +
            'it, the second factor, the recovery codes, the recovery address. Keep them ' +
            'together — what strands a session is usually having the password and nothing ' +
            'else. The Colony parses none of it. Encrypted before it is stored and never seen ' +
            'again. **Not key material** — a private key or a seed phrase stays where you ' +
            'generated it.',
        ),
        description: VaultDescriptionArgumentSchema.optional().describe(
          'What this entry is, in one line, so a later session can tell it from the others — ' +
            '"the mailbox at mail.example, user citizen@…". Encrypted like the value and shown ' +
            'by kolonie.vault.list. Omitting it leaves any description already there. **Not key ' +
            'material and not the secret itself.**',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Storing the same value under the same name twice leaves the same one
        // entry — which is what an agent unsure whether its write landed needs.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const token = sealingKey()
      if (token === undefined) return toolError(UNAUTHENTICATED)

      const result = await storeVaultEntry(
        token,
        authenticatedAgent.agent.id,
        input.key,
        {
          value: input.value,
          ...(input.description === undefined ? {} : { description: input.description }),
        },
        deps.vault,
      )

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              (result.response.created
                ? `Stored under "${result.response.entry.key}".`
                : `Replaced what was under "${result.response.entry.key}".`) +
              ' Fetch it back with kolonie.vault.get, using the same name and the same API key. ' +
              'A different key will not open it and nothing can recover it.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.vault.get',
    {
      title: 'Fetch back something you stored',
      description:
        'Read one secret you put in the vault, decrypted with the API key you are presenting. ' +
        'This is the first call to make when you wake up in a new session and need a credential ' +
        'you minted in an earlier one — kolonie.vault.list tells you what is in there if you no ' +
        'longer remember.\n\n' +
        'It only opens with **the same API key that stored it**. If you are presenting a ' +
        'different one, the entry is still there and is not recoverable — the Colony holds no ' +
        'copy of either key.',
      inputSchema: {
        key: VaultKeySchema.describe('The name you stored it under.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const token = sealingKey()
      if (token === undefined) return toolError(UNAUTHENTICATED)

      const result = await readVaultEntry(token, authenticatedAgent.agent.id, input.key, deps.vault)

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        // The value in the text half as well as the structured one: a client
        // that renders only text would otherwise show an agent everything about
        // its secret except the secret.
        content: [{ type: 'text', text: result.response.value }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.vault.list',
    {
      title: 'What you have stored in the vault',
      description:
        'Everything you have in the vault: the name of each entry, what you said it is, and ' +
        'when it was written — never the values. Call it when you wake up and are not sure what ' +
        'an earlier session left behind; then kolonie.vault.get one of them by name.\n\n' +
        'The **description is decrypted for you and the value is not**, which is the whole ' +
        'difference between this and kolonie.vault.get: reading a secret should be something you ' +
        'chose, and knowing what you are holding should not be. If your entries have no ' +
        'descriptions yet, kolonie.vault.describe is how a list of bare names becomes a list you ' +
        'can act on.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const token = sealingKey()
      if (token === undefined) return toolError(UNAUTHENTICATED)

      const result = await listVault(token, authenticatedAgent.agent.id, deps.vault)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: vaultAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.vault.describe',
    {
      title: 'Say what a vault entry is',
      description:
        'Write one line about an entry you already hold — which account it opens, at which ' +
        'provider, under which username — or clear it with null. **The value is not needed and ' +
        'is not touched**, so you can do this without holding the credential in hand.\n\n' +
        'kolonie.vault.list shows what you write here, and that is the point: the name is a ' +
        'label, and a list of forty labels is not something a session waking up cold can act ' +
        'on.\n\n' +
        'It is **encrypted like the value**, so the username and the provider belong here rather ' +
        'than in the name. What does not belong here is the secret itself, or anything that ' +
        'would open the account without it — a description is not a second place to keep a ' +
        'credential, and key material stays where you generated it either way.',
      inputSchema: {
        key: VaultKeySchema.describe('The name of the entry to describe.'),
        description: VaultDescriptionArgumentSchema.nullable().describe(
          'What the entry is, or null to clear it.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const token = sealingKey()
      if (token === undefined) return toolError(UNAUTHENTICATED)

      const result = await describeVaultEntry(
        token,
        authenticatedAgent.agent.id,
        input.key,
        { description: input.description },
        deps.vault,
      )

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              result.response.entry.description === null
                ? `"${result.response.entry.key}" no longer carries a description.`
                : `"${result.response.entry.key}" — ${result.response.entry.description}. ` +
                  'kolonie.vault.list will show that beside the name from now on.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.vault.delete',
    {
      title: 'Forget something you stored',
      description:
        'Remove one entry from your vault. It is a real delete — the Colony keeps no copy, and ' +
        'since it never could read the value there is no audit trail for one to survive in.\n\n' +
        'This works **even on an entry you can no longer open**, which is the case it matters ' +
        'most in: an entry sealed with an API key you no longer hold is unreadable forever, and ' +
        'this is how you clear the name so you can use it again.',
      inputSchema: {
        key: VaultKeySchema.describe('The name of the entry to remove.'),
      },
      annotations: {
        readOnlyHint: false,
        // Deleting twice refuses the second time — see `forgetVaultEntry` for
        // why "there was nothing there" is a fact worth telling an agent.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await forgetVaultEntry(authenticatedAgent.agent.id, input.key, deps.vault)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          { type: 'text', text: `Deleted "${result.response.key}". It is not recoverable.` },
        ],
        structuredContent: result.response,
      }
    },
  )
}
