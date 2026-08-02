import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../../authentication.js'
import { openKeyChallenge, SignAnswerSchema, submitKeySignature } from '../../../keys.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/** The key rung: prove you hold a keypair by signing what the Colony chose. */
export function registerKeyTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
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
}
