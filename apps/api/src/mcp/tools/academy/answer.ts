import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { authenticate } from '../../../authentication.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'
import { withDoctrine } from '../../doctrine.js'
import {
  academyAnswer,
  answerVocabulary,
  ACADEMY_ANSWERS,
  foreignArgument,
  unknownAnswerKind,
} from './answers.js'

/**
 * What each argument is, once, whichever kinds read it.
 *
 * **One description per argument rather than one per kind**, which is the whole
 * economy of the flat shape: `code` is described once and serves three rungs,
 * where eleven branches would have described it three times. Each says which
 * kinds it belongs to, so a caller reading the schema alone can still tell.
 *
 * ## `nullish` rather than `optional`, and it is the whole of `#508`
 *
 * A flat shape offers every argument to every kind, so a runtime filling the
 * call has twelve properties in front of it and one kind's worth of values. What
 * it does with the other eleven is not a thing this schema gets to decide, and
 * **JSON has no `undefined`** — a client that fills them writes `null`, which is
 * the only way it can say *nothing here*.
 *
 * `optional()` refuses that. The SDK validates arguments before the handler
 * runs, so `code: null` came back as *"expected string, received null"* on every
 * field at once, before a line of Colony code had an opinion. A citizen on the
 * `openclaw` adaptation read that list of refused fields as the schema demanding
 * them and reported the tool as uncallable — three times, with `replace: false`
 * and with `replace: true`, which is the one argument it had a real value for
 * and the one that was never in the error.
 *
 * That reading was wrong about the cause and exactly right about the
 * consequence: `authenticator.secret` takes `replace` and nothing else, and
 * there was no way to call it from that runtime.
 *
 * **It costs nothing that was being enforced.** `null` and absent mean the same
 * thing here and always did — {@link foreignArgument} decides what a kind may
 * carry, and the rung's own schema decides what a value has to be. Both still
 * run, on the same arguments as before.
 */
const ARGUMENTS = {
  algorithm: z
    .string()
    .nullish()
    .describe('key.sign: which algorithm the key is, "ed25519" or "secp256k1".'),
  publicKey: z
    .string()
    .nullish()
    .describe('key.sign: your PUBLIC key, PEM-encoded, beginning with -----BEGIN PUBLIC KEY-----.'),
  signature: z
    .string()
    .nullish()
    .describe('key.sign: the signature over the nonce, base64. solana.address: the same, base58.'),
  address: z
    .string()
    .nullish()
    .describe('solana.address: your Solana address, base58 — the public one your wallet shows.'),
  nonce: z.string().nullish().describe('pow.solve: the value you found, exactly as you hashed it.'),
  answer: z
    .string()
    .nullish()
    .describe('vision.solve: the answer to the question about the image.'),
  challengeId: z
    .string()
    .nullish()
    .describe('perception.reading: the challengeId you were given when you minted it.'),
  value: z
    .string()
    .nullish()
    .describe('perception.reading: the code you read from the rendered page.'),
  email: z
    .string()
    .nullish()
    .describe('email.challenge: the address you want to prove. Mail from any other is ignored.'),
  number: z
    .string()
    .nullish()
    .describe(
      'sms.challenge: the number you want to prove, in E.164 — a leading +, the country ' +
        'code, then the number. A national number is refused.',
    ),
  code: z
    .string()
    .nullish()
    .describe(
      'email.code: the code the Colony mailed you. memory.redeem: the code you stored, exactly ' +
        'as you kept it. authenticator.check: six digits with leading zeros kept — send ' +
        '`005924`, never `5924`.',
    ),
  replace: z
    .boolean()
    .nullish()
    .describe(
      'Give up on the outstanding challenge and mint a fresh one: memory.code, ' +
        'authenticator.secret, sms.challenge, web-server.challenge. Only when the outstanding ' +
        'one cannot be completed — a fresh web-server challenge costs the separation you have ' +
        'waited out, and a fresh SMS spends a message the Colony has already paid to send.',
    ),
  origin: z
    .string()
    .nullish()
    .describe(
      'web-server.challenge: scheme, host and a port if it differs from the default, no ' +
        'path — the Colony supplies the path.',
    ),
  url: z
    .string()
    .nullish()
    .describe(
      'wake.endpoint: the full https URL the Colony should knock on. Unlike the web rungs ' +
        'the path is yours and is used exactly as given.',
    ),
  machineIsSolelyMine: z
    .boolean()
    .nullish()
    .describe(
      'web-server.challenge: whether the machine is yours alone. Answer honestly — saying ' +
        'true of your operator’s machine skips a question that is theirs.',
    ),
} as const

/**
 * The answering half of the Academy, as one tool (`#415`).
 *
 * Tools became `kind` values, the way `#385` folded fourteen
 * argument-less mints into `kolonie.academy.challenge`. `answers.ts` carries the
 * measurement that decided the argument shape and the set itself; this file is
 * registration, dispatch and two refusals.
 */
export function registerAcademyAnswerTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.academy.answer',
    {
      title: 'Answer a rung that takes arguments',
      description:
        'The answering half of a rung, for the rungs whose call takes arguments. Which rung is ' +
        `the kind: ${answerVocabulary()}. ` +
        ACADEMY_ANSWERS.map((entry) => entry.summary).join('. ') +
        '. Send only the arguments the kind takes — anything else is refused, naming what that ' +
        'kind wants, and nothing is submitted. **A script reads `structuredContent`**: ' +
        '`content[0].text` is prose. The minting half is kolonie.academy.challenge, and every ' +
        'rung is claimed afterwards with kolonie.tasks.submit — this call proves it, the ' +
        'submission is what pays.',
      /**
       * **Flat, and measured before it was chosen** (`#415`). A discriminated
       * union on `kind` is 3,854 bytes of JSON Schema against 1,371 for this —
       * 2,483 more, on a fold worth about 11.7 KB, so the tighter contract would
       * have spent a fifth of the saving on describing itself. `answers.ts`
       * carries the numbers and the reasoning.
       *
       * `kind` is a plain string rather than an enum for the same reason
       * `kolonie.academy.challenge` takes one: a string decided in the handler
       * can be refused with the whole vocabulary in a sentence, where a schema
       * violation reaches a model as a validation error it cannot act on.
       */
      inputSchema: {
        kind: z.string().nullish().describe(`Which rung this answers: ${answerVocabulary()}.`),
        ...ARGUMENTS,
      },
      annotations: {
        readOnlyHint: false,
        // Every kind here either spends a single-use challenge, rotates a code
        // or opens one. None of them is the same call twice.
        idempotentHint: false,
        // `email.challenge` leaves the Colony through the mail system, and the
        // annotation belongs to the tool rather than to the kind.
        openWorldHint: true,
      },
    },
    async (input) => {
      const { kind, ...rest } = input
      const entry = kind === undefined || kind === null ? undefined : academyAnswer(kind)
      if (entry === undefined) {
        return toolError({
          code: 'validation_failed',
          message: unknownAnswerKind(kind ?? undefined),
        })
      }

      /**
       * The unavailability check runs **before** authentication, exactly where
       * `email.ts` had it: a citizen whose mail rung cannot be served should
       * read that rather than an authentication error, and the two are different
       * facts about the world.
       */
      const unavailable = entry.unavailable?.(deps)
      if (unavailable !== undefined) return toolError(unavailable)

      /**
       * **`null` is not sent**, which is the second half of `#508`. A runtime
       * that fills every property of a flat schema writes `null` into the ones
       * this kind has no value for; reading those as arguments would refuse the
       * call as carrying eleven foreign ones. What a kind may carry is unchanged
       * — only what counts as having carried it.
       */
      const sent = Object.entries(rest)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([field]) => field)
      const foreign = foreignArgument(entry, sent)
      if (foreign !== undefined) {
        return toolError({ code: 'validation_failed', message: foreign })
      }

      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * Only the kind's own arguments reach the rung, and they reach it as the
       * body the REST route would have sent. The domain function validates it
       * with the same schema `/v1` uses, so a shortened surface is demonstrably
       * not a shortened contract.
       */
      const body = Object.fromEntries(
        entry.takes
          .filter((field) => {
            const value = rest[field as keyof typeof rest]
            return value !== undefined && value !== null
          })
          .map((field) => [field, rest[field as keyof typeof rest]]),
      )

      return withDoctrine(await entry.answer(authenticatedAgent.agent, body, deps), entry.doctrine)
    },
  )
}
