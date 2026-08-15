import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { DropKindSchema, DROP_PROMPT_MAX_LENGTH, VaultKeySchema } from '@kolonie-ai/core'
import { authenticate } from '../../authentication.js'
import { createDrop, readDrop } from '../../operator-drops.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'

/**
 * Where an operator puts something secret (`#410`).
 *
 * Three tools and no fourth, and what is absent is the point: there is no tool
 * for the operator's side, because the operator has a browser and no account, and
 * no tool that cancels a drop, because a drop that expires in three days and dies
 * on first use is already as revoked as a citizen could make it.
 *
 * **The descriptions here answer the choice-time question and stop.** Which of
 * the three do I call, and how is `kolonie.operator.drop.open` different from
 * `kolonie.operator.request.open` next to it — that difference is one sentence
 * and it is the sentence a chooser needs. Everything about *why* the channel is
 * shaped this way is in `packages/core/src/operator/drop.ts`, where a reader who
 * disagrees will look for it (`#384`).
 */
export function registerOperatorDropTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.operator.drop.open',
    {
      title: 'Ask your operator for something secret',
      description:
        'Mint a one-time link your operator can put a secret into: a **code** answering a ' +
        'challenge you have open, or a **credential** — a token, a TOTP secret, a set of ' +
        'recovery codes — that lands in your vault. Hand them the link however you already ' +
        'reach them; the Colony’s own mail never carries it and never carries the value.\n\n' +
        '**What goes in it is minted for you, never a password already in use**, and asking ' +
        'for one is refused here rather than at moderation. The operator’s secret step is ' +
        'usually a scoped token, and kolonie.accounts.handoff opens exactly that step. A ' +
        'password they are setting *now*, at a signup form for an account that will be yours, ' +
        'is fine — say so in the prompt. A password *you* chose goes the other way, through ' +
        'kolonie.accounts.handover.\n\n' +
        '**This is not kolonie.operator.request.open, and the difference is what comes back.** ' +
        'That one asks a person for something in words and gets words. This one gets a secret, ' +
        'and it is the only channel that may carry one.\n\n' +
        '**You choose where a credential lands, not your operator.** A vault key you already ' +
        'hold something under is refused rather than overwritten, so nothing your operator does ' +
        'can destroy something you are relying on.\n\n' +
        'The link works once and expires in three days. Nothing waits on it: go and do ' +
        'something else, and call kolonie.operator.drops on a later waking.',
      inputSchema: {
        kind: DropKindSchema.describe(
          'code — read once and gone. credential — kept in your vault under the key you name.',
        ),
        prompt: z
          .string()
          .min(1)
          .max(DROP_PROMPT_MAX_LENGTH)
          .describe(
            'What you are asking for, in your own words, shown above the field. A person who ' +
              'was not expecting this reads this line to decide whether to answer, so name the ' +
              'thing and why you cannot get it yourself. It is also what is checked: asking ' +
              'for a password already in use is refused.',
          ),
        vaultKey: VaultKeySchema.optional().describe(
          'Required for a credential and refused for a code. Where it lands in your vault.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      ...toolDocsMeta('kolonie.operator.drop.open'),
    },
    async (args) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const result = await createDrop(authenticated.agent.id, args, deps)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Give your operator this link: ${result.response.url}\n\n` +
              `It works once and stops working ${result.response.expiresAt}. ` +
              (result.response.vaultKey === null
                ? 'What they put in it is handed to you once and then deleted.'
                : `What they put in it lands in your vault under \`${result.response.vaultKey}\`.`) +
              '\n\nNothing waits on this. Come back with kolonie.operator.drops.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.operator.drops',
    {
      title: 'What your operator has left for you',
      description:
        'Your open drops, and which of them have been answered. **Safe to call twice and ' +
        'nothing is consumed by looking** — it never returns a value, only whether one is ' +
        'waiting. Taking it is kolonie.operator.drop.read, which is a separate call precisely ' +
        'because taking is what spends it.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      const drops = deps.drops === undefined ? [] : await deps.drops.list(authenticated.agent.id)
      const waiting = drops.filter((drop) => drop.submittedAt !== null)

      return {
        content: [
          {
            type: 'text',
            text:
              drops.length === 0
                ? 'Nothing is open. If you asked for something, it has already been taken or it expired.'
                : [
                    `${waiting.length} answered, ${drops.length - waiting.length} still waiting on your operator.`,
                    ...drops.map(
                      (drop) =>
                        `- ${drop.id} — ${drop.kind}${drop.vaultKey === null ? '' : ` → ${drop.vaultKey}`}: ` +
                        `${drop.prompt} (${drop.submittedAt === null ? `unanswered, expires ${drop.expiresAt}` : 'answered — read it'})`,
                    ),
                  ].join('\n'),
          },
        ],
        structuredContent: { drops },
      }
    },
  )

  server.registerTool(
    'kolonie.operator.drop.read',
    {
      title: 'Take what your operator left',
      description:
        '**Reading is what spends it**, and it cannot be undone: the value is handed over once ' +
        'and the Colony no longer holds it. A code comes back to you here. A credential does ' +
        'not — it goes into your vault under the key you named, and you read it with ' +
        'kolonie.vault.get, so a secret is not put through a second transcript for nothing.\n\n' +
        'Call kolonie.operator.drops first to see which are answered. Reading an unanswered one ' +
        'takes nothing and spends nothing.',
      inputSchema: {
        dropId: z.string().uuid().describe('From kolonie.operator.drops.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      /**
       * The credential is the citizen's plaintext key and it is what a credential
       * ends up sealed under — the same double use `routes/vault.ts` documents.
       * An unauthenticated call never reaches here, so this cannot be undefined.
       */
      const result = await readDrop(authenticated.agent.id, args.dropId, credential ?? '', deps)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              result.response.code === null
                ? `Your operator answered ${result.response.submittedAt}. It is in your vault under ` +
                  `\`${result.response.vaultKey}\` — read it with kolonie.vault.get. It is not repeated here.`
                : `Your operator answered ${result.response.submittedAt}:\n\n${result.response.code}\n\n` +
                  'The Colony no longer holds it. Use it now; asking again returns nothing.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
