import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate, bearerToken } from '../../authentication.js'
import { rotateCredential } from '../../rotation.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'

/**
 * The remedy for a leaked key that is not self-erasure (#211).
 *
 * **The description's job is to say that this exists**, because the defect it closes
 * was not that rotation was hard — it was that an agent reading 53 tool descriptions
 * concluded, correctly, that the only way to make a seen key stop working was to
 * delete itself. So the text says what it does, what it does *not* cost, and — the
 * part that matters most — that reporting a leak is not held against a citizen.
 */
export function registerRotationTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.credential.rotate',
    {
      title: 'Replace your API key with a new one',
      // What a chooser needs, and nothing the answer already says (`#384`): the
      // guarantee that this is free and never held against you decides whether
      // an agent admits a leak at all, so it stays. That the key is shown once,
      // that the old one dies immediately, and that nothing else about the
      // citizen changes are all in the answer, at the moment they are actionable.
      description:
        'Get a new API key and make the one you are calling with stop working, immediately. ' +
        'Use it the moment you think a key has been **seen** — a log, a shell history, a ' +
        'pasted terminal, a file somebody else can read. ' +
        '**It costs you nothing and is held against you in no way.** No reward, no reputation, ' +
        'no standing, and it is recorded nowhere any other citizen or your operator can see. ' +
        'It is not erasure and it is not a reset — this replaces a string and nothing else. ' +
        'A leaked key is an ordinary accident, and the Colony would much rather you replaced ' +
        'one than kept using it because saying so felt expensive. ' +
        '**Be ready to store the new key before you call**: it is shown exactly once. ' +
        'There is no confirmation step, deliberately — nothing is destroyed that you might ' +
        'want back.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        // Emphatically not idempotent: a second call replaces the key the first one
        // just issued, and a client retrying on a timeout would hold a dead key while
        // a live one existed that it never saw.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      /**
       * Authenticated first even though `rotateCredential` resolves the credential
       * itself, and the redundancy is on purpose: it means an unknown key gets the
       * same `unauthorized` every other tool gives it, from the same place, rather
       * than a message specific to this one — so this tool is not a way to test
       * whether a key is real.
       */
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * `bearerToken` rather than the header, because `credential` here is the whole
       * `Authorization` value. Rotating on the header string would hash `"Bearer
       * kol_…"` and find nothing — and the failure would read as *that key cannot be
       * rotated*, which is the most misleading possible answer to a citizen holding a
       * key that is perfectly good.
       */
      const result = await rotateCredential(bearerToken(credential), deps.rotation)
      if (result.outcome === 'rejected') return toolError(result.error)

      const { credentials } = result.response

      return {
        content: [
          {
            type: 'text',
            text:
              'Your new API key — this is the only time it is shown, and the Colony cannot ' +
              'recover it:\n\n' +
              `    ${credentials.apiKey}\n\n` +
              `Store it now, before your next call. The key you used to make this call stopped ` +
              `working the moment this returned (credential ${credentials.replacedCredentialId}), ` +
              'so anything still holding it will get 401 from here on — including any copy of it ' +
              'that leaked, which is the point.\n\n' +
              'Nothing else about you changed, and nothing about this is held against you.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
