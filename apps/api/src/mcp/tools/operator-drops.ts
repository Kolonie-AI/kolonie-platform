import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The three that carried a secret from a person to their agent (`#410`),
 * retired (`#1444`, epic `#1437`).
 *
 * ## Why they refuse rather than disappear
 *
 * Measured in production 2026-08-20: **7 drops opened, 0 ever filled.** The one
 * channel that let an operator hand their agent a secret never carried one in
 * its whole lifetime. A citizen calling one of these holds a skill or a memory
 * naming it, and an unknown-tool error tells it nothing it can act on — so for
 * one release each says what replaced it and which call to make.
 *
 * ## The case they covered that a share had to be checked against
 *
 * A drop could be opened for a credential the citizen did **not** yet hold: the
 * operator minted a token and it arrived in a vault key the citizen had named in
 * advance. A share starts from an entry that already exists, so `#1444` asks for
 * that case to be verified rather than assumed.
 *
 * **It is covered.** The citizen writes a placeholder with `kolonie.vault.set`,
 * shares it, and the operator writes the real value into it from the durable
 * page; `kolonie.vault.unshare` hands it back. What differs is that the value
 * lands in the citizen's hands rather than being written straight into the vault
 * under the Colony's key — which is `#1437` decision 4 working as intended: the
 * citizen decides what to keep, and the Colony could not seal to the citizen's
 * key in any case.
 *
 * The refusals below say that, in the words a citizen holding the old mental
 * model needs to hear it in.
 */
export function registerOperatorDropTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  const retired = (name: string, title: string, description: string, refusal: string): void => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {},
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        const authenticatedAgent = await authenticate(credential, deps.store)
        if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

        return toolError({ code: 'conflict', message: refusal })
      },
    )
  }

  const WHAT_REPLACED_IT =
    'Write a placeholder under the name you want it to land in with kolonie.vault.set, share ' +
    'that entry with kolonie.vault.share saying what you need, and your operator writes the ' +
    'real value into it from the durable page they already hold. kolonie.vault.unshare ends ' +
    'the share and hands you what they wrote, once.'

  retired(
    'kolonie.operator.drop.open',
    'Retired — share a vault entry instead',
    '**Retired** (`#1444`). This minted a one-time link for your operator to put a secret ' +
      'into. Over its whole lifetime 7 were opened and **none** was ever filled.\n\n' +
      '**What replaces it: kolonie.vault.share.** ' +
      WHAT_REPLACED_IT +
      '\n\nCalling this mints nothing.',
    'kolonie.operator.drop.open is retired and mints nothing. Seven were opened over the life ' +
      'of the channel and none was ever filled. ' +
      WHAT_REPLACED_IT,
  )

  retired(
    'kolonie.operator.drops',
    'Retired — kolonie.vault.list shows what is shared',
    '**Retired** (`#1444`). This listed the one-time links you had open. There is nothing to ' +
      'list: kolonie.vault.list names every entry a person can currently read, says whether ' +
      'they have opened it, and says whether they have written anything back.',
    'kolonie.operator.drops is retired and there is nothing waiting. kolonie.vault.list names ' +
      'every entry your operator can currently read, whether they have opened it, and whether ' +
      'they have written something back.',
  )

  retired(
    'kolonie.operator.drop.read',
    'Retired — kolonie.vault.unshare collects it',
    '**Retired** (`#1444`). This took the value out of a filled link, once. ' +
      'kolonie.vault.unshare is the equivalent: it ends the share and hands you whatever your ' +
      'operator wrote into the entry, once, for the same reason — taking is what spends it.',
    'kolonie.operator.drop.read is retired. kolonie.vault.unshare ends a share and hands you ' +
      'what your operator wrote into it, once — the same rule, on the channel that replaced ' +
      'this one.',
  )
}
