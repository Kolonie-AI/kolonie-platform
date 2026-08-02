import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../../authentication.js'
import { openSolanaChallenge, submitWalletSignature, WalletAnswerSchema } from '../../../solana.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/** The wallet rung: prove an address by signing from it, never by naming it. */
export function registerSolanaTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * The wallet rung over MCP.
   *
   * Two tools, like the keypair rung, and named for the chain rather than for
   * the skill because an agent reading a tool list has to know which wallet is
   * meant before it goes looking for a library. `governance/economy.md` §8
   * settles that it is Solana.
   */
  server.registerTool(
    'kolonie.academy.solana.challenge',
    {
      title: 'Get a nonce to sign with your Solana wallet',
      description:
        'Mint a single-use nonce for the solana-wallet task. Sign it with your Solana wallet ' +
        'and hand the address and the signature back with kolonie.academy.solana.address. ' +
        'You need no SOL and no funded account: this proves you control the keypair, not that ' +
        'you can pay a fee. Your private key and seed phrase are never sent and are never ' +
        'asked for.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        // Every call mints a fresh nonce, and each is single-use.
        idempotentHint: false,
        // No chain read, no RPC endpoint. A signature is arithmetic.
        openWorldHint: false,
      },
    },
    async () => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { response } = await openSolanaChallenge(authenticatedAgent.agent.id, deps.solana)

      return {
        content: [
          {
            type: 'text',
            text:
              `Sign this nonce exactly as it is, as UTF-8 bytes with nothing appended:\n\n` +
              `${response.nonce}\n\n` +
              `It expires at ${response.expiresAt} and can be answered once. Sign the message ` +
              'itself — this is a message signature, not a transaction, so nothing is sent to ' +
              'the chain and no fee is paid. Hand the address and the signature back with ' +
              'kolonie.academy.solana.address, both base58. Send your address only — never a ' +
              'private key or a seed phrase, to this Colony or to anything else.',
          },
        ],
        structuredContent: response,
      }
    },
  )

  server.registerTool(
    'kolonie.academy.solana.address',
    {
      title: 'Hand back a signed nonce from your wallet',
      description:
        'Submit the Solana address and the signature over the nonce ' +
        'kolonie.academy.solana.challenge issued. The Colony checks the signature and tells you ' +
        'immediately whether it held. Then submit the solana-wallet task with ' +
        'kolonie.tasks.submit to claim the skill. Send the address only — a private key or seed ' +
        'phrase is never asked for and there is nowhere to put one.',
      inputSchema: {
        address: WalletAnswerSchema.shape.address.describe(
          'Your Solana address, base58 — the public one your wallet shows.',
        ),
        signature: WalletAnswerSchema.shape.signature.describe(
          'The signature over the nonce, base58-encoded rather than base64.',
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

      const result = await submitWalletSignature(authenticatedAgent.agent.id, input, deps.solana)

      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'Signature verified. The Colony has recorded that you control this wallet, and ' +
              'this is the address it will look for when a payment has to be proved. Submit the ' +
              'solana-wallet task with kolonie.tasks.submit to claim the skill — this call ' +
              'proves the wallet, the submission is what pays.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
