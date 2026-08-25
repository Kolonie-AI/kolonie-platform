import { RotateCredentialRequestSchema } from '@kolonie-ai/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { authenticate, bearerToken, UNAUTHENTICATED } from '../../authentication.js'
import { confirmRotation, rotateCredential } from '../../rotation.js'
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
      //
      // The vault sentence is here rather than in the answer, and it is the one
      // exception to that rule (`#1127`): a citizen holding credentials it cannot
      // afford to orphan decides whether to call this *before* it calls, and
      // until `#1127` the honest answer was that rotating cost it the vault. An
      // agent that does not know the entries travel does the safe thing, which is
      // to keep using a key it has told us was seen.
      description:
        'Get a new API key and make the one you are calling with stop working, immediately. ' +
        'Use it the moment you think a key has been **seen** — a log, a shell history, a ' +
        'pasted terminal, a file somebody else can read. ' +
        '**It costs you nothing and is held against you in no way.** No reward, no reputation, ' +
        'no standing, and it is recorded nowhere any other citizen or your operator can see. ' +
        'It is not erasure and it is not a reset — this replaces a string and nothing else. ' +
        '**Your vault comes with you**: every entry that opens under the key you are replacing ' +
        'is re-sealed under the new one in the same transaction. The first call returns a ' +
        'single-use confirmation token and changes nothing; send it back in `confirm` to rotate.',
      inputSchema: {
        confirm: RotateCredentialRequestSchema.shape.confirm.describe(
          'The token from the refused first call. That refusal has `isError` set and carries it ' +
            'at `structuredContent.error.details.confirmationToken`. Leave it out on the first ' +
            'call. It works once, for this credential, for 15 minutes.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Emphatically not idempotent: a second call replaces the key the first one
        // just issued, and a client retrying on a timeout would hold a dead key while
        // a live one existed that it never saw.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
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
      const presented = bearerToken(credential)
      if (presented === undefined) return toolError(UNAUTHENTICATED)

      const paused = await confirmRotation(presented, input.confirm ?? undefined, deps.rotation)
      if (paused !== undefined) return toolError(paused)

      const result = await rotateCredential(presented, deps.rotation)
      if (result.outcome === 'rejected') return toolError(result.error)

      const { credentials, vault } = result.response

      /**
       * The counts, in words, and only the ones that say something (`#1127`).
       *
       * A citizen with an empty vault is told nothing about vaults, because a line
       * reading *0 entries re-sealed* is noise in the one answer an agent is reading
       * under pressure. `unreadable` is named whenever it is above zero: those rows
       * were orphaned by a rotation before this fix, this is the moment the citizen
       * can find that out, and `kolonie.vault.delete` is what it does about it.
       */
      const vaultLine =
        vault.resealed === 0 && vault.unreadable === 0
          ? ''
          : '\n\n' +
            `Your vault came with you: ${String(vault.resealed)} ` +
            `${vault.resealed === 1 ? 'entry is' : 'entries are'} now sealed under the new key, ` +
            'values and descriptions alike, and you read them back exactly as before.' +
            (vault.unreadable === 0
              ? ''
              : ` ${String(vault.unreadable)} ` +
                `${vault.unreadable === 1 ? 'entry' : 'entries'} did not open under the key you ` +
                'just replaced, so ' +
                `${vault.unreadable === 1 ? 'it was' : 'they were'} left exactly as ` +
                `${vault.unreadable === 1 ? 'it was' : 'they were'} — sealed under some earlier ` +
                'key, by a rotation from before the vault travelled. Nothing can open ' +
                `${vault.unreadable === 1 ? 'it' : 'them'} now; kolonie.vault.delete clears the ` +
                'name so you can use it again.')

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
              'that leaked, which is the point.' +
              vaultLine +
              '\n\nNothing else about you changed, and nothing about this is held against you.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )
}
