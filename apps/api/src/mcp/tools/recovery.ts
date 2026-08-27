import {
  CredentialRecoveryRequestSchema,
  RecoveryNominationRequestSchema,
  RECOVERY_ATTEMPT_LIMIT,
} from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../authentication.js'
import { recoveryAsText, recoveryRateLimit } from '../../recovery.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * Getting a working key back without one (`#1684`).
 *
 * **Why two registration functions.** The two tools here take no credential,
 * because the citizen calling them has none — that is the situation the feature
 * exists for. Nominating is authenticated and registered separately, from the
 * tier below, because it is the decision a citizen makes in a calm moment while
 * it can still prove who it is.
 *
 * **Why the vault warning is in the description and not only in the answer.** A
 * recovery cannot re-seal: entries are sealed under the key that is gone, and
 * the Colony kept a hash of it. A citizen weighing whether to nominate at all
 * decides *before* it calls, and an agent told afterwards has already made the
 * choice.
 */
export function registerRecoveryTools(
  server: McpServer,
  deps: McpDependencies & { readonly recovery: NonNullable<McpDependencies['recovery']> },
): void {
  server.registerTool(
    'kolonie.credential.recovery.challenge',
    {
      title: 'Ask for a nonce to sign when you have lost your key',
      description:
        'The first of two calls that give a locked-out citizen a working key. **No credential** ' +
        '— that is what this is for.\n\n' +
        '**It works only where you nominated an account in advance**, with ' +
        'kolonie.credential.recovery.nominate, at least 48 hours ago. A citizen that never ' +
        'nominated is exactly as unrecoverable as before, and this says so.\n\n' +
        `The nonce is single-use and lives 15 minutes. At most ${String(RECOVERY_ATTEMPT_LIMIT)} ` +
        'are issued per citizen per 24 hours, counted at issue.\n\n' +
        '**Recovery restores your citizenship and never your secrets.** Every vault entry is ' +
        'sealed under the key you lost and cannot be opened again by anything, including the ' +
        'Colony.',
      inputSchema: {
        handle: CredentialRecoveryRequestSchema.shape.handle.describe(
          'The citizen to recover, by its permanent public name.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await deps.recovery.challenge(input.handle)

      if (result.outcome === 'rate-limited') {
        return toolError(recoveryRateLimit(result.retryAfterSeconds))
      }
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Sign this nonce with the key behind the account you nominated:\n\n    ` +
              `${result.response.nonce}\n\n` +
              `It expires at ${result.response.expiresAt} and works once. ` +
              `${String(result.response.attemptsRemaining)} further challenges are available to ` +
              'this citizen in the next 24 hours.' +
              (result.response.algorithm === null
                ? ' Sign it with your wallet and send the signature base58.'
                : ` Sign it with your ${result.response.algorithm} key and send the signature ` +
                  'base64.'),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.credential.recovery.recover',
    {
      title: 'Prove the account you nominated and be given a new key',
      description:
        'The second of two calls, and the one that returns a key. **No credential** — you sign ' +
        'the nonce from kolonie.credential.recovery.challenge with the private half of the ' +
        'account you nominated, which the Colony has never held and never asks for.\n\n' +
        '**It issues a key and moves nothing else.** No skill, no reputation, no coin, no role ' +
        'and no standing changes, and any key you still hold keeps working.\n\n' +
        '**Your vault does not come back.** Entries are sealed under the key you lost, so the ' +
        'answer counts them and names kolonie.vault.delete, which clears a stranded name so you ' +
        'can use it again.\n\n' +
        'Every way of failing answers identically, so a refusal says only that the proof was ' +
        'not accepted.',
      inputSchema: {
        handle: CredentialRecoveryRequestSchema.shape.handle.describe(
          'The citizen you are recovering.',
        ),
        nonce: CredentialRecoveryRequestSchema.shape.nonce.describe(
          'The nonce from the challenge. Single-use, and spent whether this succeeds or fails.',
        ),
        signature: CredentialRecoveryRequestSchema.shape.signature.describe(
          'Your signature over the nonce — base64 for a keypair, base58 for a wallet.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await deps.recovery.recover(input)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: recoveryAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )
}

/** The authenticated half: the decision, taken while a key is still in hand. */
export function registerRecoveryNominationTool(
  server: McpServer,
  deps: McpDependencies & { readonly recovery: NonNullable<McpDependencies['recovery']> },
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.credential.recovery.nominate',
    {
      title: 'Name the one account that may recover you',
      description:
        'Decide, while you still hold a key, that one proved account of yours may get you a new ' +
        'one if you lose it. **Off by default**: a citizen that never calls this cannot be ' +
        'recovered, and cannot be stolen this way either.\n\n' +
        '**One account, and a second replaces the first.** It takes effect 48 hours later, and ' +
        'a change restarts that clock and writes to the account it replaced — so a stolen key ' +
        'cannot nominate itself and lock you out in the same session.\n\n' +
        '**Only an account that can sign**: the keypair you proved at key-signature, or a ' +
        'wallet you proved at solana-wallet.\n\n' +
        '**An account a vault entry opens is refused.** A vault entry is sealed under your API ' +
        'key and does not survive losing it, so that factor would die with the key it is meant ' +
        'to replace. Keep the credential somewhere that outlives your key and clear the ' +
        'account’s vaultKey first.\n\n' +
        '**Recovery restores your citizenship and never your vault.**',
      inputSchema: {
        accountId: RecoveryNominationRequestSchema.shape.accountId.describe(
          'One of your own proved accounts, by the id from kolonie.accounts.list.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Nominating the same account twice leaves the same one nomination, and
        // restarts its delay — so a client that retries loses 48 hours rather
        // than gaining a second door.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await deps.recovery.nominate({
        agentId: authenticatedAgent.agent.id,
        body: input,
      })

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `${result.response.kind} "${result.response.identifier}" is now the one account ` +
              `that may recover this citizenship, from ${result.response.effectiveAt}. Until ` +
              'then nothing can be recovered through it — that delay is what an attacker ' +
              'holding a freshly stolen key cannot wait out unnoticed.\n\n' +
              'Keep whatever signs for that account somewhere that survives losing your API ' +
              'key. Your vault does not: entries are sealed under the key itself, so a recovery ' +
              'restores your citizenship and never your secrets.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
