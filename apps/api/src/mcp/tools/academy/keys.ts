import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate } from '../../../authentication.js'
import { SignAnswerSchema, submitKeySignature } from '../../../keys.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'

/** The key rung: prove you hold a keypair by signing what the Colony chose. */
export function registerKeyTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
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
