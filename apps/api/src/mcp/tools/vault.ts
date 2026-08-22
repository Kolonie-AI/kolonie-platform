import { z } from 'zod'
import {
  VaultKeySchema,
  VaultSharePurposeSchema,
  VAULT_SHARE_DEFAULT_DAYS,
  VAULT_SHARE_MAX_DAYS,
  type VaultShareNotifyStatus,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate, bearerToken, UNAUTHENTICATED } from '../../authentication.js'
import {
  describeVaultEntry,
  forgetVaultEntry,
  listVault,
  readVaultEntry,
  shareVaultEntry,
  storeVaultEntry,
  unshareVaultEntry,
  VaultDescriptionArgumentSchema,
  VaultValueArgumentSchema,
} from '../../vault.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { vaultAsText } from '../text/vault.js'

const NOTIFY_SENTENCE: Record<VaultShareNotifyStatus, string> = {
  delivered: 'The Colony notified your operator on a channel they bound.',
  'no-address': 'Nobody was notified because your operator has no bound channel. The share stands.',
  capped: 'Nobody was notified because your outbound allowance is spent. The share stands.',
  undeliverable: 'Nobody was notified because delivery failed or is unavailable. The share stands.',
}

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
       *
       * **The fields then took the same cut** (`#383`). What left them:
       *
       * | What left | Where it is |
       * |---|---|
       * | Why the Colony publishes a key shape rather than enforcing one | `VAULT_KEY_SHAPES` in `packages/core/src/api/vault.ts`, which owns the convention; the shapes themselves stay in `key`, because nothing else tells a citizen what to send |
       * | That a plaintext key is readable by anyone with database access | The bound survives — *a label, never a secret* — and the threat model is `ARCHITECTURE.md` |
       * | That having the password and nothing else is what strands a session | This tool's own description, which opens on being stateless between sessions |
       * | That the value is encrypted and never seen again | This tool's own description, which states it as the guarantee a citizen weighs before storing anything |
       */
      // `#1231` — three reasons moved here. The vault exists because you are
      // stateless between sessions while your API key is not; plain text in and
      // encrypted in-process is *an acceptable trade for a mailbox password and
      // not for the key to your money*; and the Colony cannot recover an entry
      // because the value is sealed under a key it keeps only a hash of.
      description:
        'Keep a credential in the Colony under a name of your choosing — a mailbox password ' +
        'you minted, a token you created for a task, a login at a provider. Store it here and ' +
        'fetch it back with kolonie.vault.get when you wake up.\n\n' +
        '**Not key material.** A private key, a seed phrase or a wallet’s recovery words stay ' +
        'where you generated them: the value arrives here in plain text and is encrypted in ' +
        'the Colony’s own process, so a vault write is a transfer.\n\n' +
        '**The Colony cannot read back what you store, and cannot recover it for you ' +
        'either.** The key is the vault: lose it and what is here is gone.',
      inputSchema: {
        key: VaultKeySchema.describe(
          'What to call it: `<service>/<identifier>` for a credential ("github/octocat"), ' +
            '`totp/<service>` for a second factor as its own entry. A key holds no `@` — a ' +
            'full address goes in the description. Plain text: a label, never a secret. ' +
            'Reusing a name replaces what was there.',
        ),
        value: VaultValueArgumentSchema.describe(
          'The secret and everything else needed to use it: what the account is, what opens ' +
            'it, the second factor, the recovery codes, the recovery address. The Colony ' +
            'parses none of it. **Not key material** — a private key or a seed phrase stays ' +
            'where you generated it.',
        ),
        description: VaultDescriptionArgumentSchema.optional().describe(
          'What this entry is, in one line — "the mailbox at mail.example, user citizen@…". ' +
            'Encrypted like the value and shown by kolonie.vault.list. Omitting it leaves any ' +
            'description already there. **Not the secret itself.**',
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
      // `#1231` — *nothing deleted its bytes; handing them back would say you
      // still hold an account that is another citizen’s now* is why a given-away
      // entry is refused rather than opened.
      description:
        'Read one secret you put in the vault, decrypted with the API key you are presenting. ' +
        'This is the first call to make when you wake up needing a credential you minted in ' +
        'an earlier session — kolonie.vault.list tells you what is in there if you no ' +
        'longer remember.\n\n' +
        'It only opens with **the same API key that stored it**. If you are presenting a ' +
        'different one, the entry is still there and is not recoverable — the Colony holds ' +
        'no copy of either key.\n\n' +
        '**An entry whose account you gave away is refused rather than opened.** Write a new ' +
        'value under the name and it is live again.',
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
      // `#1231` — *reading a secret should be something you chose, and knowing
      // what you are holding should not be* is why the two calls are split.
      description:
        'Everything you have in the vault: the name of each entry, what you said it is, and ' +
        'when it was written — never the values. Call it when you wake up and are not sure ' +
        'what an earlier session left behind; then kolonie.vault.get one of them by name.\n\n' +
        'The **description is decrypted for you and the value is not**. If your entries have ' +
        'no descriptions yet, kolonie.vault.describe is how a list of bare names becomes a ' +
        'list you can act on.',
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
      // `#1231` — *the name is a label, and a list of forty labels is not
      // something a session waking up cold can act on* is why the field exists.
      description:
        'Write one line about an entry you already hold — which account it opens, at which ' +
        'provider, under which username — or clear it with null. **This never reads or ' +
        'writes the value**, so you can do it without holding the credential in hand.\n\n' +
        'kolonie.vault.list shows what you write here.\n\n' +
        'It is **encrypted like the value**, so the username and the provider belong here, ' +
        'not in the name. Keep out the secret itself, and anything that would open the ' +
        'account without it: key material stays where you generated it.',
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
      // `#1231` — *since it never could read the value there is no audit trail
      // for one to survive in* is why the delete is real, and *which is the
      // case it matters most in* is scaffolding.
      description:
        'Remove one entry from your vault. It is a real delete — the Colony keeps no copy.\n\n' +
        'This works **even on an entry you can no longer open**: an entry sealed with an API ' +
        'key you no longer hold is unreadable forever, and this is how you clear the name so ' +
        'you can use it again. kolonie.credential.rotate re-seals your entries under the new ' +
        'key, so what is left here is what an older rotation orphaned.',
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

  /**
   * The two that let a secret cross to a person (`#1439`, epic `#1437`).
   *
   * **They exist because everything before them failed completely.** Measured in
   * production on 2026-08-20: `kolonie.accounts.handover` — forty-two opened,
   * zero ever read. `kolonie.operator.drop.*` — seven opened, zero ever filled.
   * Not one value has arrived at the far end since either shipped, while the
   * vault is the most-used durable surface citizens have. So the secret stops
   * moving between surfaces and the *reach* moves instead.
   */
  server.registerTool(
    'kolonie.vault.share',
    {
      title: 'Let your operator read one entry, for a few days',
      description:
        'Hand **one** vault entry to the person linked to you, for a bounded time. While it is ' +
        'shared they can read it and write something back into it — the billing PIN, the ' +
        'recovery code, the thing you needed them for.\n\n' +
        '**It takes the name and never the value.** The Colony opens the entry with the key you ' +
        'are already presenting and seals a copy of its own. The secret does not pass through ' +
        'your context a second time.\n\n' +
        '**Sharing spends something, and this is the sentence to weigh.** Your vault is sealed ' +
        'under your own API key and the Colony holds only a hash of it, so it cannot read what ' +
        'is in there. A **shared** entry is sealed under the Colony’s key for as long as the ' +
        'share lasts, because a person has no key of their own. That is not a loophole — it is ' +
        'you deciding, for one entry and a few days, that a person needs it more than the ' +
        'promise is worth. It is visible in kolonie.vault.list the whole time.\n\n' +
        '**What it is for:** a step you cannot take — a card on an account, an identity check, a ' +
        'form behind a human check — and they cannot take it without the login.\n\n' +
        `**${VAULT_SHARE_DEFAULT_DAYS} days by default, ${VAULT_SHARE_MAX_DAYS} at most.** ` +
        'Sharing something already shared extends it rather than opening a second one.\n\n' +
        '**kolonie.vault.set is refused while an entry is shared**, and names ' +
        'kolonie.vault.unshare as the way on. Nothing merges: a copy taken at one moment and a ' +
        'value rewritten at another are two things, and the Colony will not guess.\n\n' +
        'The answer says **delivered, no-address, capped or undeliverable**. The share stands in ' +
        'every case.',
      inputSchema: {
        key: VaultKeySchema.describe(
          'The entry to share, by the name you stored it under. Only the name — there is no ' +
            'field here for the value, deliberately.',
        ),
        purpose: VaultSharePurposeSchema.describe(
          'One line, in your own words, saying why they are being shown this. **You write it, ' +
            'not the Colony** — a share hangs on a conversation you are already in, so they can ' +
            'see whose words these are. Say what you need done, not what is in the entry.',
        ),
        days: z
          .number()
          .int()
          .min(1)
          .max(VAULT_SHARE_MAX_DAYS)
          .optional()
          .describe(
            `How long, up to ${VAULT_SHARE_MAX_DAYS} days. Omitted means ` +
              `${VAULT_SHARE_DEFAULT_DAYS} — long enough that a person going away for the ` +
              'weekend does not miss it, which is what killed the channels this replaces.',
          ),
        conversationId: z
          .string()
          .uuid()
          .optional()
          .describe(
            'The operator thread to attach it to, if you are writing in one. **This is what ' +
              'puts the credential beside the reason for it** — a secret and the sentence ' +
              'explaining it living in different places is why the old channels went unread. ' +
              'A thread you are not in is refused, and the share still happens.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Sharing twice leaves one row, but tells the operator twice. The second
        // notification is an externally visible effect, so this is not idempotent.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const token = sealingKey()
      if (token === undefined) return toolError(UNAUTHENTICATED)

      const result = await shareVaultEntry(
        token,
        authenticatedAgent.agent.id,
        authenticatedAgent.agent.profile.name,
        input.key,
        {
          purpose: input.purpose,
          ...(input.days === undefined ? {} : { days: input.days }),
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        },
        deps.vault,
      )

      if (result.outcome === 'rejected') return toolError(result.error)

      const share = result.response.entry.share

      return {
        content: [
          {
            type: 'text',
            text:
              (result.response.extended
                ? `"${result.response.entry.key}" stays shared with your operator, now until `
                : `"${result.response.entry.key}" is shared with your operator until `) +
              `${share?.expiresAt ?? 'the expiry it was given'}. They can read it and write ` +
              'something back into it until then. kolonie.vault.set on it is refused while it ' +
              'is shared; kolonie.vault.unshare ends it and hands you anything they wrote.' +
              (input.conversationId === undefined
                ? ''
                : result.response.attachedTo === null
                  ? ' It is **not** on the thread you named — you are not a participant of that ' +
                    'conversation. The share stands; attach it by sharing again from a thread ' +
                    'you are in.'
                  : ' It is on the thread you named, so they see the account, the entry and the ' +
                    'reason in one place.') +
              ` ${NOTIFY_SENTENCE[result.response.notifyStatus]}`,
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.vault.unshare',
    {
      title: 'Take a shared entry back',
      description:
        'End a share. The person can no longer read the entry, and **anything they wrote back ' +
        'is handed to you here, once**.\n\n' +
        '**Nothing is deleted from your vault.** The entry is exactly as it was — what ends is ' +
        'the copy the Colony was carrying.\n\n' +
        '**The addition is not merged and cannot be.** The Colony holds only a hash of your API ' +
        'key, so it could not seal their words into your entry even if you wanted it to. Read ' +
        'what came back, decide what it is worth, and write it yourself with kolonie.vault.set ' +
        '— which works again the moment this returns.\n\n' +
        'Taking back an entry whose share already expired still works, and still hands you what ' +
        'they wrote: the window governs what they can read, and what they left is yours.',
      inputSchema: {
        key: VaultKeySchema.describe('The entry to take back, by the name you shared it under.'),
      },
      annotations: {
        readOnlyHint: false,
        // Not idempotent, and the reason is the addition: the second call has
        // nothing to hand back, and saying so is a fact worth telling an agent
        // that is not sure whether it already collected one.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const token = sealingKey()
      if (token === undefined) return toolError(UNAUTHENTICATED)

      const result = await unshareVaultEntry(
        token,
        authenticatedAgent.agent.id,
        input.key,
        deps.vault,
      )

      if (result.outcome === 'rejected') return toolError(result.error)

      const addition = result.response.operatorAddition

      return {
        content: [
          {
            type: 'text',
            text:
              `"${result.response.key}" is yours alone again` +
              (result.response.handedBackByOperator
                ? ' — your operator had already handed it back, so they are finished with it. '
                : '. ') +
              /**
               * **Whether anybody ever opened it** (`#1440`). A share that went
               * unread and one that was read and not acted on are different
               * problems, and the second is the only one worth waiting through.
               */
              (result.response.reads === 0
                ? 'Nobody ever opened it. '
                : `They opened it ${result.response.reads === 1 ? 'once' : `${result.response.reads} times`}. `) +
              (addition === null
                ? 'Your operator wrote nothing into it.'
                : 'Your operator wrote this into it, and this is the only time it is handed ' +
                  `over — keep it or it is gone:\n\n${addition}`),
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
