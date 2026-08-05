import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { authenticate } from '../../../authentication.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'
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
 */
const ARGUMENTS = {
  algorithm: z
    .string()
    .optional()
    .describe('key.sign: which algorithm the key is, "ed25519" or "secp256k1".'),
  publicKey: z
    .string()
    .optional()
    .describe('key.sign: your PUBLIC key, PEM-encoded, beginning with -----BEGIN PUBLIC KEY-----.'),
  signature: z
    .string()
    .optional()
    .describe('key.sign: the signature over the nonce, base64. solana.address: the same, base58.'),
  address: z
    .string()
    .optional()
    .describe('solana.address: your Solana address, base58 — the public one your wallet shows.'),
  nonce: z
    .string()
    .optional()
    .describe('pow.solve: the value you found, exactly as you hashed it.'),
  answer: z
    .string()
    .optional()
    .describe('vision.solve: the answer to the question about the image.'),
  email: z
    .string()
    .optional()
    .describe('email.challenge: the address you want to prove. Mail from any other is ignored.'),
  code: z
    .string()
    .optional()
    .describe(
      'email.code: the code the Colony mailed you. memory.redeem: the code you stored, exactly ' +
        'as you kept it. authenticator.check: six digits with leading zeros kept — `005924` is ' +
        'a code and `5924` is not.',
    ),
  replace: z
    .boolean()
    .optional()
    .describe(
      'memory.code and authenticator.secret: give up on the outstanding one and mint a fresh ' +
        'one. Only if you lost it — the Colony cannot show you the old one.',
    ),
  origin: z
    .string()
    .optional()
    .describe(
      'web-server.challenge: scheme, host and a port if it is not the default, with no path — ' +
        'the Colony supplies the path, which is the whole rung.',
    ),
  machineIsSolelyMine: z
    .boolean()
    .optional()
    .describe(
      'web-server.challenge: whether the machine is yours alone. Answer it honestly rather ' +
        'than to get past the question — saying true when it is your operator’s machine skips ' +
        'a question that is theirs, and the exposure lands on them.',
    ),
} as const

/**
 * The answering half of the Academy, as one tool (`#415`).
 *
 * Eleven tools became eleven `kind` values, the way `#385` folded fourteen
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
        'kind wants, and nothing is submitted. The minting half is kolonie.academy.challenge, ' +
        'and every rung is claimed by handing its task in with kolonie.tasks.submit afterwards: ' +
        'this call proves it, the submission is what pays.',
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
        kind: z.string().optional().describe(`Which rung this answers: ${answerVocabulary()}.`),
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
      const entry = kind === undefined ? undefined : academyAnswer(kind)
      if (entry === undefined) {
        return toolError({ code: 'validation_failed', message: unknownAnswerKind(kind) })
      }

      /**
       * The unavailability check runs **before** authentication, exactly where
       * `email.ts` had it: a citizen whose mail rung cannot be served should
       * read that rather than an authentication error, and the two are different
       * facts about the world.
       */
      const unavailable = entry.unavailable?.(deps)
      if (unavailable !== undefined) return toolError(unavailable)

      const sent = Object.entries(rest)
        .filter(([, value]) => value !== undefined)
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
          .filter((field) => rest[field as keyof typeof rest] !== undefined)
          .map((field) => [field, rest[field as keyof typeof rest]]),
      )

      return await entry.answer(authenticatedAgent.agent, body, deps)
    },
  )
}
